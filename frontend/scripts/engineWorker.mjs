// Run the shipped analysis worker under Node.
//
// The worker is not reimplemented here. `frontend/public/rpsfish/` is loaded
// and executed as-is inside a vm context with the handful of browser globals
// it touches, so a measurement taken through this module is a measurement of
// the path the website actually runs.

import { readFile } from 'node:fs/promises';
import { createContext, runInContext } from 'node:vm';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { dirname, resolve as resolvePath } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKER_PATH = resolvePath(HERE, '../public/rpsfish/rpsfish-worker.js');
const WASM_PATH = resolvePath(HERE, '../public/rpsfish/rpsfish.wasm');

/**
 * Start the worker and return the two request shapes it serves.
 *
 * `analyze(position, options)` resolves with the final snapshot for one
 * position. `review({ positions, moves, analyzeFrom, options }, onEntry)`
 * walks a whole game from `analyzeFrom` onwards and resolves with one entry
 * per position it graded, calling `onEntry` as each arrives.
 */
export const startEngineWorker = async () => {
  const [source, wasmBytes] = await Promise.all([
    readFile(WORKER_PATH, 'utf8'),
    readFile(WASM_PATH),
  ]);

  let onMessage;
  const listeners = new Map();
  const sandbox = {
    WebAssembly,
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
    set: (handler) => {
      onMessage = handler;
    },
  });
  sandbox.location = { href: 'https://arena.invalid/rpsfish/rpsfish-worker.js', search: '' };
  sandbox.postMessage = (data) => {
    const listener = listeners.get(data?.requestId);
    if (listener) listener(data);
  };
  // `WebAssembly.instantiateStreaming` needs a real Response; skipping it sends
  // the worker down its own documented fallback path.
  sandbox.WebAssembly = { instantiate: WebAssembly.instantiate.bind(WebAssembly) };

  createContext(sandbox);
  runInContext(source, sandbox, { filename: WORKER_PATH });

  let nextRequestId = 1;
  const request = (message, settle) =>
    new Promise((resolvePromise, rejectPromise) => {
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
      onMessage({ data: { ...message, requestId } });
    });

  const analyze = (position, options = {}) => {
    const { signal, ...engineOptions } = options;
    return request({ type: 'analyze', position, options: engineOptions }, (data, settle) => {
      if (data.type === 'analysis-update') return;
      if (data.type === 'analysis') settle.resolve(data.analysis);
      else settle.reject(new Error(data.message ?? 'analysis failed'));
    });
  };

  const review = ({ positions, moves, analyzeFrom = 0, options = {} }, onEntry) =>
    request({ type: 'review', positions, moves, analyzeFrom, options }, (data, settle) => {
      if (data.type === 'review-progress') {
        onEntry?.(data.entry, data.total);
        return;
      }
      if (data.type === 'review') settle.resolve(data.entries);
      else settle.reject(new Error(data.message ?? 'review failed'));
    });

  return { analyze, review };
};
