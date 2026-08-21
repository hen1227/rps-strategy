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

let worker;
let nextRequestId = 1;
const pending = new Map();
const DEFAULT_MAX_TIME_MS = 3_000;
const MAX_ENGINE_TIME_MS = 120_000;
const RESPONSE_GRACE_MS = 5_000;
// The worker and WASM are copied from public/ without hashed filenames. Keep
// this in step with engine/worker releases so browsers cannot combine builds.
const RPSFISH_ASSET_VERSION = 'abi3-rules2';

const abortError = () => {
  const error = new Error('RPSFish analysis was cancelled.');
  error.name = 'AbortError';
  return error;
};

const finishRequest = (requestId) => {
  const request = pending.get(requestId);
  if (!request) return undefined;
  pending.delete(requestId);
  clearTimeout(request.timeoutId);
  request.removeAbortListener?.();
  return request;
};

const rejectPending = (message) => {
  for (const requestId of pending.keys()) {
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

    const finished = finishRequest(data.requestId);
    if (data.type === 'analysis') finished.resolve(data.analysis);
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

const responseTimeoutMs = (maxTimeMs) => {
  const engineTimeMs = Number.isFinite(maxTimeMs)
    ? Math.max(1, Math.min(MAX_ENGINE_TIME_MS, Math.floor(maxTimeMs)))
    : DEFAULT_MAX_TIME_MS;
  return engineTimeMs + RESPONSE_GRACE_MS;
};

const stopWorker = (targetWorker, pendingMessage) => {
  if (!targetWorker || worker !== targetWorker) return;
  targetWorker.terminate();
  worker = undefined;
  if (pendingMessage) rejectPending(pendingMessage);
};

/**
 * Analyze a position with hard depth/node/time limits.
 *
 * `onUpdate` receives the last fully completed depth while the returned
 * promise resolves to the final trustworthy snapshot. Pass an AbortSignal as
 * `options.signal` to stop between iterations.
 */
export const analyzePosition = (position, options = {}, onUpdate) => {
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
    const timeoutId = setTimeout(() => {
      const request = finishRequest(requestId);
      if (!request) return;
      stopWorker(
        requestWorker,
        'RPSFish did not respond in time. The analysis worker was restarted.',
      );
      request.reject(
        new Error('RPSFish did not respond in time. The analysis worker was restarted.'),
      );
    }, responseTimeoutMs(engineOptions.maxTimeMs));
    pending.set(requestId, {
      onUpdate,
      reject,
      removeAbortListener: signal
        ? () => signal.removeEventListener('abort', cancel)
        : undefined,
      resolve,
      timeoutId,
    });
    requestWorker.postMessage({ type: 'analyze', requestId, position, options: engineOptions });
  });
};
