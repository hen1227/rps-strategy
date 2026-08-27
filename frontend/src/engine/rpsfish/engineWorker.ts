// Where a lane gets an engine to talk to, on every platform but the web.
//
// Resolved by platform: Metro picks `engineWorker.web.ts` for the browser and
// this file for iOS and Android, so neither bundle carries the other's way of
// running RPSFish. `client.ts` imports one name from here and never learns
// which it got.

import { createNativeWorker, isNativeEngineAvailable } from './nativeSession';
import type { EngineWorker } from './protocol';

/**
 * Whether this build can run RPSFish.
 *
 * A real question off the web: the engine is compiled into the binary, so a
 * JavaScript bundle can be running in an app that was built without it, or
 * against an ABI it no longer speaks. Screens ask so they can offer what they
 * can deliver.
 */
export const isEngineAvailable = () => isNativeEngineAvailable();

export const createEngineWorker = (): EngineWorker => createNativeWorker();
