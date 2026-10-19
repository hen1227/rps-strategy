// The phones' half of match alerts: everything that needs `expo-notifications`.
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
// one place, in `push.ts`, so the transports cannot drift into different state
// machines. An iPhone and an Android phone differ here in three small ways —
// what can rule a device out, the channel Android needs before it will ask, and
// how a summons shown while the app was away is recognised — and in nothing
// above this file.

import Constants from 'expo-constants';
import { requireOptionalNativeModule } from 'expo';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

import type { NativePushFacts, NativePushTransport } from './push';

/** How the OS answered, in the three words the store thinks in. */
export type NativePermission = 'granted' | 'denied' | 'unasked';

/**
 * The Android channel every summons is posted on. The server names it on each
 * message (`fcmChannel` in `backend/internal/server/fcm.go`), so the two must
 * agree.
 */
const ALERTS_CHANNEL = 'match-alerts';

/** The tag the server puts on a summons, on every transport. */
const SUMMONS_TAG = 'rps-match';

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
 * On iOS a simulator is reported as unsupported rather than merely allowed to
 * fail: on Apple silicon it hands over a token that looks perfectly real and
 * that only `xcrun simctl push` can ever deliver to, so registering it would
 * leave an account looking reachable for ever. On Android the thing to rule out
 * is a build made without a `google-services.json`, which has no FCM token to
 * give at all; the app config says whether it had one.
 */
export const nativeFacts = (transport: NativePushTransport): NativePushFacts => {
  const hasNotificationsModule = requireOptionalNativeModule('ExpoPushTokenManager') !== null;
  if (transport === 'fcm') {
    return {
      transport,
      hasNotificationsModule,
      hasFirebaseConfig: Boolean(Constants.expoConfig?.android?.googleServicesFile),
    };
  }
  return { transport, hasNotificationsModule, isSimulator: !Device.isDevice };
};

const permissionFrom = (status: Notifications.NotificationPermissionsStatus): NativePermission => {
  if (status.granted) return 'granted';
  // `canAskAgain` is the difference that matters. iOS asks once and then never
  // again, Android twice, and a request made after that resolves without
  // showing anything — the same trap as a browser that has been told to block a
  // site, and the reason "denied" has to be a state the UI can talk about
  // rather than a button that silently does nothing.
  return status.canAskAgain ? 'unasked' : 'denied';
};

/**
 * The channel a summons is posted on, made if it is not there yet.
 *
 * Before any permission request, because Android 13 shows no prompt at all for
 * an app with no channel, and a request that shows nothing reads as "denied".
 * High importance is what lets a summons appear as a banner rather than only in
 * the shade, and a summons nobody sees for thirty seconds is a game called off.
 * Making a channel that exists already changes nothing, including anything the
 * player has changed about it since.
 */
const ensureAlertsChannel = async () => {
  if (Platform.OS !== 'android') return;
  await Notifications.setNotificationChannelAsync(ALERTS_CHANNEL, {
    name: 'Match alerts',
    description: 'When a game you are queued for starts.',
    importance: Notifications.AndroidImportance.HIGH,
    // No `sound`: a channel plays the system's own by default, and the
    // module reads the name "default" as a sound file of the app's that
    // does not exist.
  });
};

/** What the OS already thinks, asked without prompting anybody. */
export const nativePermission = async (): Promise<NativePermission> =>
  permissionFrom(await Notifications.getPermissionsAsync());

/** The prompt itself. Only ever from a press. */
export const requestNativePermission = async (): Promise<NativePermission> => {
  await ensureAlertsChannel();
  return permissionFrom(await Notifications.requestPermissionsAsync());
};

/**
 * This device's push token: APNs on an iPhone, FCM on an Android phone.
 *
 * The device token rather than an Expo push token: the notification is sent by
 * this project's own Go server, signed with this project's own key, so there is
 * no third party in the path beyond the one each platform routes through.
 */
export const nativeDeviceToken = async (): Promise<string> => {
  // Android 13 hands out no token to an app with no channel, either.
  await ensureAlertsChannel();
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
 * Whether a notification's data says it is a match summons.
 *
 * On iOS the custom keys arrive under `content.data` because the server nests
 * them under a top-level `body` in the APNs payload, which is where
 * `expo-notifications` reads them from. On Android they arrive in the flat FCM
 * data map, which is the same place. Either way, spread anywhere else they
 * would arrive as nothing — and this would quietly answer false for every
 * summons there is.
 */
const isSummons = (data: unknown): boolean =>
  typeof data === 'object' && data !== null && (data as { kind?: unknown }).kind === SUMMONS_KIND;

/**
 * Whether a notification sitting in the shade is a summons.
 *
 * One Android notification carries no data: a summons that arrived while the
 * app was in the background is posted by the system, and reads back as a
 * notification of somebody else's whose data is Android's own extras. What it
 * keeps is the tag the server set, in its identifier, so that is what is
 * matched.
 */
const isPresentedSummons = (notification: Notifications.Notification): boolean =>
  isSummons(notification.request.content.data) ||
  (Platform.OS === 'android' &&
    new RegExp(`[?&]tag=${SUMMONS_TAG}(&|$)`).test(notification.request.identifier));

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
 * Take down any summons still sitting in the notification shade.
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
      .filter(isPresentedSummons)
      .map((notification) =>
        Notifications.dismissNotificationAsync(notification.request.identifier),
      ),
  );
};
