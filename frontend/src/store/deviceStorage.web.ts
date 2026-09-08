// Where this app remembers things, in a browser: `localStorage`, as before.
// See `deviceStorage.ts` for the native store.

import type { DeviceStorage } from './deviceStorage.types';

/**
 * The browser's own storage, or `null`.
 *
 * Reached through a function rather than captured once: this module is imported
 * during a static web render, where there is no `localStorage` at all, and a
 * captured `undefined` would then persist into the browser.
 */
export const deviceStorage = (): DeviceStorage | null => {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
};
