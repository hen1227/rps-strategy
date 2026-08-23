// Run the shipped analysis worker under Node.
//
// The worker is not reimplemented here. `frontend/public/rpsfish/` is loaded
// and executed as-is inside a vm context with the handful of browser globals
// it touches, so a measurement taken through this module is a measurement of
// the path the website actually runs. `npm run build:worker` produces that
// file from `src/engine/rpsfish/worker/`, and `pretest` runs it first.

import { readFile } from 'node:fs/promises';
import { createContext, runInContext } from 'node:vm';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { dirname, resolve as resolvePath } from 'node:path';

import type { EnginePosition } from '../src/engine/analysisGame';
import type {
  Analysis,
  AnalyzePositionRequest,
  ReviewEntry,
  SearchLimits,
  WorkerRequest,
  WorkerRequestBody,
  WorkerResponse,
} from '../src/engine/rpsfish/protocol';
import type { Move } from '../src/types/game';

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKER_PATH = resolvePath(HERE, '../public/rpsfish/rpsfish-worker.js');
const WASM_PATH = resolvePath(HERE, '../public/rpsfish/rpsfish.wasm');

/** The same two calls `engine/rpsfish/client.ts` offers the browser. */
export interface NodeEngineWorker {
  analyze: (
    position: AnalyzePositionRequest,
    options?: Partial<SearchLimits> & { signal?: AbortSignal },
  ) => Promise<Analysis>;
  review: (
    body: {
      positions: EnginePosition[];
      moves: Move[];
      analyzeFrom?: number;
      options?: Partial<SearchLimits>;
    },
    onEntry?: (entry: ReviewEntry, total: number) => void,
  ) => Promise<ReviewEntry[]>;
}

/**
 * Start the worker and return the two request shapes it serves.
 *
 * `analyze(position, options)` resolves with the final snapshot for one
 * position. `review({ positions, moves, analyzeFrom, options }, onEntry)`
 * walks a whole game from `analyzeFrom` onwards and resolves with one entry
 * per position it graded, calling `onEntry` as each arrives.
 */
export const startEngineWorker = async (): Promise<NodeEngineWorker> => {
  const [source, wasmBytes] = await Promise.all([
    readFile(WORKER_PATH, 'utf8'),
    readFile(WASM_PATH),
  ]);

  let onMessage: ((event: { data: WorkerRequest }) => void) | undefined;
  const listeners = new Map<number, (data: WorkerResponse) => void>();
  const sandbox: Record<string, unknown> = {
    performance,
    setTimeout,
    clearTimeout,
    console,
    URL,
    BigInt,
    Error,
    // The worker fetches `./rpsfish.wasm` relative to its own location; in this
    // context every fetch resolves to the one file it can possibly want.
    fetch: async () => ({
      ok: true,
      status: 200,
      clone() {
        return this;
      },
      arrayBuffer: async () => wasmBytes,
    }),
  };
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  Object.defineProperty(sandbox, 'onmessage', {
    get: () => onMessage,
    set: (handler: typeof onMessage) => {
      onMessage = handler;
    },
  });
  sandbox.location = { href: 'https://arena.invalid/rpsfish/rpsfish-worker.js', search: '' };
  sandbox.postMessage = (data: WorkerResponse) => {
    listeners.get(data?.requestId)?.(data);
  };
  // `WebAssembly.instantiateStreaming` needs a real Response; skipping it sends
  // the worker down its own documented fallback path.
  sandbox.WebAssembly = { instantiate: WebAssembly.instantiate.bind(WebAssembly) };

  createContext(sandbox);
  runInContext(source, sandbox, { filename: WORKER_PATH });
  if (!onMessage) throw new Error('The RPSFish worker did not install a message handler.');
  const post = onMessage;

  interface Settle<Result> {
    resolve: (value: Result) => void;
    reject: (error: Error) => void;
  }

  let nextRequestId = 1;
  const request = <Result,>(
    message: WorkerRequestBody,
    settle: (data: WorkerResponse, handlers: Settle<Result>) => void,
  ) =>
    new Promise<Result>((resolvePromise, rejectPromise) => {
      const requestId = nextRequestId++;
      listeners.set(requestId, (data) =>
        settle(data, {
          resolve: (value) => {
            listeners.delete(requestId);
            resolvePromise(value);
          },
          reject: (error) => {
            listeners.delete(requestId);
            rejectPromise(error);
          },
        }),
      );
      post({ data: { ...message, requestId } as WorkerRequest });
    });

  const analyze: NodeEngineWorker['analyze'] = (position, options = {}) => {
    const { signal: _signal, ...engineOptions } = options;
    return request<Analysis>(
      { type: 'analyze', position, options: engineOptions },
      (data, settle) => {
        if (data.type === 'analysis-update') return;
        if (data.type === 'analysis') settle.resolve(data.analysis);
        else settle.reject(new Error('message' in data ? data.message : 'analysis failed'));
      },
    );
  };

  const review: NodeEngineWorker['review'] = (
    { positions, moves, analyzeFrom = 0, options = {} },
    onEntry,
  ) =>
    request<ReviewEntry[]>(
      { type: 'review', positions, moves, analyzeFrom, options },
      (data, settle) => {
        if (data.type === 'review-progress') {
          onEntry?.(data.entry, data.total);
          return;
        }
        if (data.type === 'review') settle.resolve(data.entries);
        else settle.reject(new Error('message' in data ? data.message : 'review failed'));
      },
    );

  return { analyze, review };
};
