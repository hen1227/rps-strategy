// The iOS half of match alerts: everything that needs `expo-notifications`.
//
// It is a module of its own, and `push.ts` reaches it with `await import()`
// rather than a plain import, for the reason stated at the top of that file:
// `push.ts` is loaded during the static web export, which runs in Node, and by
// the unit tests, which run in Node with no native modules at all. A static
// import here would be evaluated in both. Everything in this file is therefore
// only ever reached from a phone.
//
// It deliberately holds no state and no policy. It answers questions about the
// device and returns what it finds; which status that adds up to is decided in
// one place, in `push.ts`, so the two transports cannot drift into two
// different state machines.

import { requireOptionalNativeModule } from 'expo';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';

import type { ApnsFacts } from './push';

/** How the OS answered, in the three words the store thinks in. */
export type ApnsPermission = 'granted' | 'denied' | 'unasked';

/**
 * What the capability decision is made from.
 *
 * The module is asked for the way `modules/rpsfish` asks for the engine, and for
 * the same reason: the JavaScript half of `expo-notifications` is present in any
 * bundle that imports it, so the only honest question is whether the *binary*
 * running that bundle was built with the native half. It is not, in the state
 * every installed build is left in by adding a native module — and reporting
 * that as unsupported beats throwing when somebody presses the button.
 *
 * A simulator is reported as unsupported rather than merely allowed to fail. On
 * Apple silicon it will hand over a token that looks perfectly real and that
 * only `xcrun simctl push` can ever deliver to — so registering it would leave
 * an account looking reachable for ever while every summons went nowhere, which
 * is precisely the ghost the away queue must not contain.
 */
export const apnsFacts = (): ApnsFacts => ({
  transport: 'apns',
  hasNotificationsModule: requireOptionalNativeModule('ExpoPushTokenManager') !== null,
  isSimulator: !Device.isDevice,
});

const permissionFrom = (status: Notifications.NotificationPermissionsStatus): ApnsPermission => {
  if (status.granted) return 'granted';
  // `canAskAgain` is the difference that matters. iOS asks once and then never
  // again, and a request made after that resolves without showing anything —
  // the same trap as a browser that has been told to block a site, and the
  // reason "denied" has to be a state the UI can talk about rather than a
  // button that silently does nothing.
  return status.canAskAgain ? 'unasked' : 'denied';
};

/** What the OS already thinks, asked without prompting anybody. */
export const apnsPermission = async (): Promise<ApnsPermission> =>
  permissionFrom(await Notifications.getPermissionsAsync());

/** The prompt itself. Only ever from a press. */
export const requestApnsPermission = async (): Promise<ApnsPermission> =>
  permissionFrom(await Notifications.requestPermissionsAsync());

/**
 * This device's APNs token.
 *
 * The device token rather than an Expo push token: the notification is sent by
 * this project's own Go server, signed with this project's own Apple key, so
 * there is no third party in the path and nothing to configure beyond the key.
 */
export const apnsDeviceToken = async (): Promise<string> => {
  const token = await Notifications.getDevicePushTokenAsync();
  if (typeof token.data !== 'string' || token.data === '') {
    throw new Error('This device did not return a notification token.');
  }
  return token.data;
};

/**
 * The kind the server sends unasked. Anything else was asked for by somebody
 * pressing a button, which is the whole difference below.
 */
const SUMMONS_KIND = 'match_started';

/**
 * Whether a notification is a match summons.
 *
 * The custom keys arrive under `content.data` because the server nests them
 * under a top-level `body` in the APNs payload, which is where
 * `expo-notifications` reads them from for a remote notification. Spread at the
 * top level of the payload they would arrive as nothing at all — and this
 * function would quietly answer false for every summons there is.
 */
const isSummons = (data: unknown): boolean =>
  typeof data === 'object' && data !== null && (data as { kind?: unknown }).kind === SUMMONS_KIND;

/**
 * What to do with a notification that arrives while the app is already open.
 *
 * A summons: nothing. The board is on screen, the chime has played, and the
 * socket got there first — a banner over the top of it is the notification that
 * teaches people to mute an app, which is fatal here, because a muted app cannot
 * be called back at all. `sw.js` makes the same judgement on the web by having
 * a visible tab close the banner itself.
 *
 * Anything else: shown. That means the test notification, and suppressing that
 * would break the one check that proves the chain works end to end — the web
 * build closes only the `rps-match` tag, for exactly this reason.
 */
export const presentQuietlyInForeground = () => {
  Notifications.setNotificationHandler({
    handleNotification: async (notification) => {
      const summons = isSummons(notification.request.content.data);
      return {
        shouldShowBanner: !summons,
        shouldShowList: !summons,
        shouldPlaySound: !summons,
        shouldSetBadge: false,
      };
    },
  });
};

/**
 * Take down any summons still sitting in Notification Center.
 *
 * Called when the app comes to the front. The web build does this from the
 * service worker message; here there is nothing to message, so the app does it
 * on arrival. Summons only, again: a test notification somebody is in the middle
 * of looking at is not residue.
 */
export const dismissDeliveredSummons = async () => {
  const presented = await Notifications.getPresentedNotificationsAsync();
  await Promise.all(
    presented
      .filter((notification) => isSummons(notification.request.content.data))
      .map((notification) =>
        Notifications.dismissNotificationAsync(notification.request.identifier),
      ),
  );
};
