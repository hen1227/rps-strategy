import Constants from 'expo-constants';
import { Platform } from 'react-native';

// What this build is, for a bug report to carry.
//
// Sent by the client rather than worked out on the server, and that is the
// whole reason this file exists: the user agent of a React Native app says
// almost nothing, and on the web it says a great deal about the browser and
// nothing about which build of this app is loaded. The build number is the one
// fact that decides whether a report is about something already fixed.
//
// Both are best-effort. A missing version is left empty rather than guessed at,
// because "unknown" written into four thousand reports is worse than a blank
// field: it looks like an answer.

/** The version this build was published as, from app.json. */
export const appVersion = (): string =>
  (Constants.expoConfig?.version ?? '').trim();

/**
 * Which kind of client this is.
 *
 * Deliberately coarse — `web`, `ios`, `android` — rather than a user agent.
 * The bugs that differ between platforms differ at that grain, and a full
 * user-agent string in a public thread is more about the reporter than about
 * the bug.
 */
export const platformName = (): string => {
  switch (Platform.OS) {
    case 'web':
      return 'web';
    case 'ios':
      return `iOS${Platform.Version ? ` ${Platform.Version}` : ''}`;
    case 'android':
      return `Android${Platform.Version ? ` ${Platform.Version}` : ''}`;
    default:
      return Platform.OS;
  }
};
