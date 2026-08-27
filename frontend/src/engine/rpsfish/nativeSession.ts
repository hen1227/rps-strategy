// RPSFish on iOS: the engine in the app's own process.
//
// The browser runs RPSFish in a worker and talks to it by message. iOS has no
// worker, so this file stands in for one: it drives the same
// `createSessionHost` over a backend that calls the native module, and
// presents the result behind the same handful of members `client.ts` uses on a
// `Worker`. That is what lets one lane implementation serve both platforms.
//
// Two facts about the native engine shape everything here. Its search state is
// process-global, so there is exactly one engine no matter how many sessions
// ask for one. And its search is synchronous on a background queue, so a
// request in flight cannot be interrupted — only abandoned.

import RPSFishNative from '../../../modules/rpsfish';
import { REQUIRED_ABI_VERSION } from './engineExports';
import type { EncodedPosition } from './engineExports';
import {
  createEngine,
  createSessionHost,
  type EngineBackend,
  type EngineLock,
} from './session';
import { squareIndex, type EngineWorker, type WorkerResponse } from './protocol';

const CHUNK_MASK = 0xffff_ffffn;

/**
 * One encoded position, as the bridge can carry it.
 *
 * Mode, side and move number are small enough to be exact doubles. The sixteen
 * bitboard words are not — a 9x9 board fills bits past the fifty-three a
 * double holds — so each crosses as two 32-bit chunks and is reassembled in
 * Swift.
 */
const toNativePosition = (encoded: EncodedPosition): number[] => {
  const values: number[] = [Number(encoded[0]), Number(encoded[1]), Number(encoded[2])];
  for (let index = 3; index < encoded.length; index += 1) {
    const word = BigInt(encoded[index]);
    values.push(Number(word & CHUNK_MASK), Number((word >> 32n) & CHUNK_MASK));
  }
  return values;
};

const unavailable = () =>
  new Error('This build of the app does not include the RPSFish engine.');

/**
 * The installed module, once it is known to be usable.
 *
 * The ABI check is the same one the worker makes after instantiating the
 * WebAssembly, and matters more here: a JavaScript bundle can be newer than
 * the native binary it is running in, and a mismatched ABI would be read as
 * plausible nonsense rather than as an error.
 */
const nativeModule = () => {
  if (!RPSFishNative) throw unavailable();
  if (RPSFishNative.abiVersion !== REQUIRED_ABI_VERSION) {
    throw new Error('This app and its RPSFish engine build are incompatible.');
  }
  return RPSFishNative;
};

export const isNativeEngineAvailable = () =>
  Boolean(RPSFishNative) && RPSFishNative?.abiVersion === REQUIRED_ABI_VERSION;

const nativeBackend: EngineBackend = {
  analyze: (encoded, maxDepth, maxNodes, maxTimeMs, variations) =>
    nativeModule().analyze(
      toNativePosition(encoded),
      maxDepth,
      maxNodes,
      maxTimeMs,
      variations,
    ),
  historySet: (history) => nativeModule().historySet(history.map(toNativePosition)),
  historyPush: (encoded) => nativeModule().historyPush(toNativePosition(encoded)),
  rootFilter: (moves) =>
    nativeModule().rootFilter(
      moves.flatMap((movement) => [squareIndex(movement.from), squareIndex(movement.to)]),
    ),
  searchClear: () => nativeModule().searchClear(),
};

/**
 * Exclusive use of the one engine, in the order asked.
 *
 * The native module already serialises individual calls on its own queue. This
 * is about *sequences* of them: standing the engine on a game line and then
 * searching from it must be indivisible, or a second caller admitted in
 * between would have replaced the repetition history under the first.
 *
 * Deliberately a queue rather than a bigger lock. Analysis takes the engine
 * for one deepening step and a review for one position, so each waits for the
 * other's current step rather than its whole request — which is what keeps a
 * bot's move from waiting out a whole game's review, and the review from
 * being abandoned every time a bot thinks.
 */
const createLock = (): EngineLock => {
  let tail: Promise<void> = Promise.resolve();
  return (unit) => {
    const run = tail.then(unit);
    // The queue must survive a failed unit, so it tracks completion only.
    tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };
};

// One engine, one lock, for the whole process — because the native search
// state is one thing. Sessions come and go as lanes are restarted; what the
// engine is standing on is remembered here, across all of them.
const sharedEngine = createEngine(nativeBackend, createLock());

/**
 * A worker-shaped session over the shared engine.
 *
 * `terminate` cannot kill a search that is already inside the native queue, so
 * it abandons instead: the host stops answering for the request, and the loops
 * stop at their next checkpoint. The engine finishes the step it is in, which
 * costs one step of work and no correctness — the next request stands the
 * engine where it needs it.
 */
export const createNativeWorker = (): EngineWorker => {
  let live = true;
  const worker: EngineWorker = {
    onmessage: null,
    onerror: null,
    onmessageerror: null,
    postMessage: (message) => {
      if (!live) return;
      void host.handleMessage(message);
    },
    terminate: () => {
      live = false;
      host.cancelAll();
    },
  };

  const host = createSessionHost(sharedEngine, (response: WorkerResponse) => {
    if (live) worker.onmessage?.({ data: response });
  });

  return worker;
};
