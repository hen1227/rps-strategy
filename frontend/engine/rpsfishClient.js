import { Platform } from 'react-native';

export const ANALYSIS_PRESETS = Object.freeze({
  standard: Object.freeze({
    maxDepth: 8,
    maxNodes: 500_000,
    maxTimeMs: 3_000,
    throttleMs: 16,
    variations: 3,
  }),
  // The node ceiling is a safety valve, not the intended limit: the engine
  // now reaches 20 million nodes in a few seconds, so a low cap ended deep
  // searches long before their time budget and cost several plies of depth.
  deep: Object.freeze({
    maxDepth: 127,
    maxNodes: 100_000_000,
    maxTimeMs: 30_000,
    throttleMs: 25,
    variations: 3,
  }),
});

/**
 * Per-position budgets for a whole-game review.
 *
 * Chosen from measurement, not taste: on a 60-position game the standard
 * preset finishes in a few seconds and the deep one in well under a minute,
 * and both stream, so the first grades appear immediately. Reviewing runs in
 * the browser, so the only cost of the deep preset is the reviewer's patience.
 */
export const REVIEW_PRESETS = Object.freeze({
  fast: Object.freeze({
    maxDepth: 6,
    maxNodes: 200_000,
    maxTimeMs: 600,
    throttleMs: 0,
    variations: 3,
  }),
  standard: Object.freeze({
    maxDepth: 9,
    maxNodes: 700_000,
    maxTimeMs: 2_000,
    throttleMs: 0,
    variations: 3,
  }),
  deep: Object.freeze({
    maxDepth: 12,
    maxNodes: 4_000_000,
    maxTimeMs: 8_000,
    throttleMs: 0,
    variations: 3,
  }),
});

let nextRequestId = 1;
const DEFAULT_MAX_TIME_MS = 3_000;
const MAX_ENGINE_TIME_MS = 120_000;
const RESPONSE_GRACE_MS = 5_000;
// The worker and WASM are copied from public/ without hashed filenames. Keep
// this in step with engine/worker releases so browsers cannot combine builds.
// `review2` adds `analyzeFrom` to the review request: a cached `review1` worker
// would ignore it and regrade a live game from move one on every instalment.
const RPSFISH_ASSET_VERSION = 'abi4-rules2-review2';

const abortError = () => {
  const error = new Error('RPSFish analysis was cancelled.');
  error.name = 'AbortError';
  return error;
};

const responseTimeoutMs = (maxTimeMs) => {
  const engineTimeMs = Number.isFinite(maxTimeMs)
    ? Math.max(1, Math.min(MAX_ENGINE_TIME_MS, Math.floor(maxTimeMs)))
    : DEFAULT_MAX_TIME_MS;
  return engineTimeMs + RESPONSE_GRACE_MS;
};

/**
 * One worker and one queue behind one set of request functions.
 *
 * A lane exists so that two kinds of work can be in flight at once. The WASM
 * search is synchronous, so a worker running a search cannot answer anything
 * else — including a cancel — until that search returns. Everything sharing a
 * worker therefore takes turns, and work that must not take turns needs a
 * worker of its own.
 */
const createLane = () => {
  let worker;
  const pending = new Map();
  let queue = Promise.resolve();

  const finishRequest = (requestId) => {
    const request = pending.get(requestId);
    if (!request) return undefined;
    pending.delete(requestId);
    clearTimeout(request.timeoutId);
    request.removeAbortListener?.();
    return request;
  };

  const rejectPending = (message) => {
    for (const requestId of [...pending.keys()]) {
      finishRequest(requestId)?.reject(new Error(message));
    }
  };

  const createWorker = () => {
    if (Platform.OS !== 'web' || typeof Worker === 'undefined') {
      throw new Error('RPSFish analysis is currently available on the website.');
    }

    const basePath = process.env.EXPO_BASE_URL || '/';
    const normalizedBase = basePath.endsWith('/') ? basePath : `${basePath}/`;
    const workerUrl = new URL(
      `${normalizedBase}rpsfish/rpsfish-worker.js`,
      window.location.origin,
    );
    workerUrl.searchParams.set('v', RPSFISH_ASSET_VERSION);
    const nextWorker = new Worker(workerUrl);

    nextWorker.onmessage = ({ data }) => {
      const request = pending.get(data?.requestId);
      if (!request) return;
      if (data.type === 'analysis-update') {
        request.onUpdate?.(data.analysis);
        return;
      }
      if (data.type === 'review-progress') {
        // A review takes as long as the game is long, so its deadline is reset
        // by progress rather than set once: the whole walk is expected to
        // outlast any single position's budget.
        request.onUpdate?.(data.entry, data.total);
        clearTimeout(request.timeoutId);
        request.timeoutId = setTimeout(request.onTimeout, request.timeoutMs);
        return;
      }

      const finished = finishRequest(data.requestId);
      if (data.type === 'analysis') finished.resolve(data.analysis);
      else if (data.type === 'review') finished.resolve(data.entries);
      else if (data.type === 'cancelled') finished.reject(abortError());
      else finished.reject(new Error(data.message ?? 'RPSFish analysis failed.'));
    };
    nextWorker.onerror = (event) => {
      if (worker !== nextWorker) return;
      const detail = event?.message ? `: ${event.message}` : '.';
      rejectPending(`The RPSFish analysis worker stopped unexpectedly${detail}`);
      nextWorker.terminate();
      worker = undefined;
    };
    nextWorker.onmessageerror = () => {
      if (worker !== nextWorker) return;
      rejectPending('RPSFish returned an unreadable response. The analysis worker was restarted.');
      nextWorker.terminate();
      worker = undefined;
    };
    return nextWorker;
  };

  const stopWorker = (targetWorker, pendingMessage) => {
    if (!targetWorker || worker !== targetWorker) return;
    targetWorker.terminate();
    worker = undefined;
    if (pendingMessage) rejectPending(pendingMessage);
  };

  /**
   * Post one request and settle when the worker answers.
   *
   * `onUpdate` receives intermediate results — the last fully completed depth
   * for an analysis, one graded position for a review — while the returned
   * promise resolves to the final answer. Pass an AbortSignal as
   * `options.signal` to stop between iterations.
   */
  const send = (message, options, onUpdate, timeoutMs) => {
    if (!worker) worker = createWorker();
    const requestWorker = worker;
    const requestId = nextRequestId++;
    const { signal, ...engineOptions } = options ?? {};

    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(abortError());
        return;
      }

      const cancel = () => {
        const request = finishRequest(requestId);
        if (!request) return;
        // The WASM search is synchronous, so a busy worker cannot process a
        // cancel message until the very search we want to cancel has finished.
        // Terminating it makes position changes and Fast Refresh immediate.
        stopWorker(
          requestWorker,
          'RPSFish restarted after another analysis was cancelled. Please try again.',
        );
        request.reject(abortError());
      };
      signal?.addEventListener('abort', cancel, { once: true });
      const onTimeout = () => {
        const request = finishRequest(requestId);
        if (!request) return;
        stopWorker(
          requestWorker,
          'RPSFish did not respond in time. The analysis worker was restarted.',
        );
        request.reject(
          new Error('RPSFish did not respond in time. The analysis worker was restarted.'),
        );
      };
      pending.set(requestId, {
        onTimeout,
        onUpdate,
        reject,
        removeAbortListener: signal
          ? () => signal.removeEventListener('abort', cancel)
          : undefined,
        resolve,
        timeoutId: setTimeout(onTimeout, timeoutMs),
        timeoutMs,
      });
      requestWorker.postMessage({ ...message, requestId, options: engineOptions });
    });
  };

  // Cancelling a request terminates this lane's worker, which is what a
  // position change wants and what two wanted answers never want. Requests
  // queued here run one at a time instead of pre-empting each other.
  const enqueue = (start, signal) => {
    const run = queue.then(() => {
      if (signal?.aborted) throw abortError();
      return start();
    });
    // The queue must survive a failed or cancelled request, so it tracks
    // completion only.
    queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  return { enqueue, send };
};

// Two lanes, because a game and the analysis of that game happen at once.
//
// The interactive lane answers whoever is looking at a position right now: the
// analysis board, the hint button, and a bot deciding its move. Those are
// short searches, and the newest one is usually the only one still wanted.
//
// The review lane grades whole games. A Deep review of a sixty-move game is
// minutes of work, and it must neither be torn down every time a bot thinks
// nor make the bots wait for it — which is exactly what would happen if both
// shared a worker, because that worker can only be inside one search at a
// time. Given its own worker, a battle plays at its own pace while the review
// walks the same game a few moves behind.
const interactiveLane = createLane();
const reviewLane = createLane();

export const analyzePosition = (position, options = {}, onUpdate) =>
  interactiveLane.send(
    { type: 'analyze', position },
    options,
    onUpdate,
    responseTimeoutMs(options.maxTimeMs),
  );

export const analyzeExclusive = (position, options = {}, onUpdate) =>
  interactiveLane.enqueue(
    () => analyzePosition(position, options, onUpdate),
    options.signal,
  );

/**
 * Grade a run of a game's positions in one request.
 *
 * The worker walks the positions itself rather than being driven one at a
 * time, which is what lets it keep the transposition table and the repetition
 * history across the walk instead of rebuilding both per position.
 * `onEntry(entry, total)` fires as each position is graded, so the screen can
 * fill in from the first move rather than after the last.
 *
 * `analyzeFrom` names the first position to grade; earlier ones are still sent
 * because the walk needs them for repetition, but they are not searched again.
 * That is what lets a game be graded while it is still being played: each
 * request picks up where the last one stopped.
 *
 * Queued, not pre-emptive: a review is minutes of work in the worst case and a
 * request that cancelled it would throw all of it away.
 */
export const reviewGame = ({ positions, moves, analyzeFrom = 0 }, options = {}, onEntry) =>
  reviewLane.enqueue(
    () =>
      reviewLane.send(
        { type: 'review', positions, moves, analyzeFrom },
        options,
        onEntry,
        // A position whose played move is outside the returned lines costs a
        // second, paired search of the same position, so one position's worst
        // case is twice its budget. The deadline has to allow for that or a
        // deep review of a sharp game would restart the worker mid-walk.
        responseTimeoutMs(options.maxTimeMs * 2),
      ),
    options.signal,
  );
