// Where this app remembers things, on a phone.
//
// A native app has no `localStorage`, and everything the web build keeps in it
// is something this app is broken without: the account id and profile key are
// the account. Left unstored they are regenerated per launch, which on the web
// happens only in a locked-down browser and on a phone would happen every
// single time.
//
// `expo-sqlite/kv-store` rather than async storage because every caller here is
// synchronous, and for a good reason: `getOrCreateUserId` has to answer before
// the first socket frame is sent. Its `*Sync` methods make this a drop-in for
// the browser's `Storage`, so `localIdentity.ts` reads the same on both.
//
// See `deviceStorage.web.ts` for the browser.

import Storage from 'expo-sqlite/kv-store';

import type { DeviceStorage } from './deviceStorage.types';

const store: DeviceStorage = {
  getItem: (key) => Storage.getItemSync(key),
  setItem: (key, value) => {
    Storage.setItemSync(key, value);
  },
  removeItem: (key) => {
    Storage.removeItemSync(key);
  },
};

/**
 * The device's store, or `null` if it cannot be opened.
 *
 * Opening the database is deferred to the first call, and a failure is
 * reported the same way a blocked browser is: as no storage. Every caller
 * already copes with that by keeping an in-memory value for the session, which
 * is a far better failure than a launch that throws.
 */
export const deviceStorage = (): DeviceStorage | null => {
  try {
    // Touch the store so a database that cannot be opened is discovered here,
    // where it reads as "no storage", rather than at an arbitrary later call.
    Storage.getItemSync('rps.storageProbe.v1');
    return store;
  } catch {
    return null;
  }
};
