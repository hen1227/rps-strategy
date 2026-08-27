// Where a lane gets an engine to talk to, in a browser: a real worker, loaded
// by URL from `public/rpsfish/`. See `engineWorker.ts` for the native side.

import type { EngineWorker } from './protocol';

// The worker and WASM are copied from public/ without hashed filenames. Keep
// this in step with engine/worker releases so browsers cannot combine builds.
// `review2` adds `analyzeFrom` to the review request: a cached `review1` worker
// would ignore it and regrade a live game from move one on every instalment.
const RPSFISH_ASSET_VERSION = 'abi4-rules2-review2';

/**
 * Whether this platform can run RPSFish at all.
 *
 * Unconditionally true on the web: the engine is served from `public/`, so it
 * is a property of the site rather than of the visitor, and a browser without
 * workers is rare enough to be worth reporting as a failure when it happens
 * rather than as a missing feature beforehand. Answering from a capability
 * check here would also make the statically rendered page disagree with the
 * hydrated one.
 */
export const isEngineAvailable = () => true;

export const createEngineWorker = (): EngineWorker => {
  if (typeof Worker === 'undefined') {
    throw new Error('This browser cannot run RPSFish analysis.');
  }

  const basePath = process.env.EXPO_BASE_URL || '/';
  const normalizedBase = basePath.endsWith('/') ? basePath : `${basePath}/`;
  const workerUrl = new URL(
    `${normalizedBase}rpsfish/rpsfish-worker.js`,
    window.location.origin,
  );
  workerUrl.searchParams.set('v', RPSFISH_ASSET_VERSION);
  // A browser `Worker` already has every member `EngineWorker` names, with the
  // same runtime behaviour; the cast is only to say so, because a DOM
  // `MessageEvent` parameter is not assignable to the plainer event the
  // native session posts.
  return new Worker(workerUrl) as unknown as EngineWorker;
};
