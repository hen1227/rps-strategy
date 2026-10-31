import { Platform } from 'react-native';

// What this build is, for the socket's `authenticate`, so a server that has
// moved on can tell an older app to update instead of leaving it to fail.
//
// The website's half, and the half Node resolves for the tests, where
// `expo-constants` cannot load. A page is never refused, because reloading it
// is all a page needs to be current, so it sends no version. The apps' half is
// `clientBuild.native.ts`.

export const appVersion = (): string => '';

/** `ios`, `android` or `web`, by the names the server's version check uses. */
export const appPlatform = (): string => Platform.OS;
