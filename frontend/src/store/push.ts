// Whether this device can be called back, and how it becomes able to be.
//
// Three transports, one state machine. A browser is reached through Web Push,
// an iPhone through APNs and an Android phone through FCM, and those have
// nothing in common on the wire — a URL and a pair of encryption keys against a
// device token — but everything in common above it: the same offer, the same
// statuses, the same one notification, and the same rule that what holds a
// place in the queue is an address the *server* knows about. Only `detect`,
// `enable`, `disable` and the two helpers they share branch, and the phones'
// half of each lives in `pushNative.ts`.
//
// A store of its own rather than a slice of the game store, following
// `bottomInset` and `reviewHandoff`: nothing in the game store needs push, and
// keeping it out means the socket and the `GameStore` union are untouched.
// `useQueueCall` reads both and hands the combination to `queueSelectors`,
// which is what lets that module stay pure.
//
// Every platform API here is reached inside a function, never at module scope.
// This file is imported during the static export, which runs in Node with no
// `window`, no `navigator` and no `Notification` — the same rule
// `localIdentity.ts` follows for `localStorage`, and for the same reason. It is
// also why `expo-notifications` is reached through `await import('./pushNative')`
// rather than imported: a native module at module scope would be evaluated by
// the export and by every unit test in this directory.

import { Platform } from 'react-native';
import { create } from 'zustand';

import { track } from '@/analytics/track';
import type { PushTransportSupport } from '@/types/protocol';

import {
  deletePushDevice,
  deletePushSubscription,
  fetchPushKey,
  savePushDevice,
  savePushSubscription,
  type PushIdentity,
} from './api/push';
import {
  getOrCreateProfileKey,
  getOrCreateUserId,
  readPushEndpoint,
  savePushEndpoint,
  clearPushEndpoint,
  readAlertsSnoozedUntil,
  saveAlertsSnoozedUntil,
} from './localIdentity';

/** How long dismissing the alerts offer keeps it out of the way. */
const SNOOZE_MS = 7 * 24 * 60 * 60 * 1000;

export type PushStatus =
  /**
   * Nothing to offer: no service worker or push manager in a browser, and on a
   * phone a build that cannot hold a real device token.
   */
  | 'unsupported'
  /** iOS in a tab. Push arrives only for a site added to the Home Screen. */
  | 'needs-home-screen'
  | 'unasked'
  | 'enabling'
  /** Permission granted *and* the server holds a live subscription. */
  | 'granted'
  /** The browser will not ask again. */
  | 'denied'
  | 'error';

export type PushCapability = 'ready' | 'needs-home-screen' | 'unsupported';

/** How this build is reached. */
export type PushTransport = 'web-push' | 'apns' | 'fcm';

/** The two a phone can be: the transports `pushNative.ts` answers for. */
export type NativePushTransport = Exclude<PushTransport, 'web-push'>;

const isNative = (transport: PushTransport): transport is NativePushTransport =>
  transport !== 'web-push';

/** The transport this build can use, or `null` where the server has no way in. */
export const activePushTransport = (): PushTransport | null => {
  switch (Platform.OS) {
    case 'web':
      return 'web-push';
    case 'ios':
      return 'apns';
    case 'android':
      return 'fcm';
    default:
      return null;
  }
};

/**
 * Whether the server can call *this* kind of device back.
 *
 * A deployment can hold VAPID keys and no Apple key, or the reverse, so the one
 * `pushEnabled` flag is not an answer a phone can use. `support` is absent when
 * the server predates iOS, and a browser then falls back to the flag that has
 * always meant exactly this to it.
 */
export const pushEnabledFor = (
  transport: PushTransport | null,
  support: PushTransportSupport | undefined,
  enabled: boolean,
): boolean => {
  if (!transport) return false;
  if (!support) return transport === 'web-push' && enabled;
  switch (transport) {
    case 'apns':
      return support.apns;
    // Absent from a server that predates Android, which has no way to reach one.
    case 'fcm':
      return support.fcm === true;
    default:
      return support.webPush;
  }
};

/**
 * What a browser's capability turns on. An absent `transport` is Web Push,
 * because that is what these four facts have always described.
 */
export type WebPushFacts = {
  transport?: 'web-push';
  hasServiceWorker: boolean;
  hasPushManager: boolean;
  isIOS: boolean;
  isStandalone: boolean;
};

/** What an iPhone build's capability turns on. */
export type ApnsFacts = {
  transport: 'apns';
  /** Whether `expo-notifications` is actually linked into this binary. */
  hasNotificationsModule: boolean;
  /**
   * A simulator is not merely likely to fail. On Apple silicon it hands over a
   * token that looks entirely real and that only `xcrun simctl push` can ever
   * deliver to, so registering it would leave an account looking reachable for
   * ever — the ghost the away queue must not contain.
   */
  isSimulator: boolean;
};

/**
 * What an Android build's capability turns on.
 *
 * No emulator rule: an emulator with Google Play services is handed a real FCM
 * token that really delivers. What an Android build can lack instead is its
 * Firebase config, without which there is no token to be had at all.
 */
export type FcmFacts = {
  transport: 'fcm';
  hasNotificationsModule: boolean;
  /** Whether the build was made with a `google-services.json`. */
  hasFirebaseConfig: boolean;
};

export type NativePushFacts = ApnsFacts | FcmFacts;

/**
 * The capability decision, as a pure function of a handful of facts about the
 * device, so it can be tested without one.
 */
export const pushCapabilityFrom = (facts: WebPushFacts | NativePushFacts): PushCapability => {
  if (facts.transport === 'apns') {
    if (!facts.hasNotificationsModule || facts.isSimulator) return 'unsupported';
    return 'ready';
  }
  if (facts.transport === 'fcm') {
    if (!facts.hasNotificationsModule || !facts.hasFirebaseConfig) return 'unsupported';
    return 'ready';
  }
  if (!facts.hasServiceWorker || !facts.hasPushManager) return 'unsupported';
  if (facts.isIOS && !facts.isStandalone) return 'needs-home-screen';
  return 'ready';
};

/**
 * A VAPID key arrives base64url and `pushManager.subscribe` wants bytes.
 *
 * Written out rather than reached for from a library because it is six lines
 * and the alternative is a dependency in the one place a mistake produces
 * "notifications silently never arrive".
 */
export const urlBase64ToUint8Array = (base64Url: string): Uint8Array => {
  const padding = '='.repeat((4 - (base64Url.length % 4)) % 4);
  const base64 = (base64Url + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = globalThis.atob(base64);
  const bytes = new Uint8Array(raw.length);
  for (let index = 0; index < raw.length; index += 1) bytes[index] = raw.charCodeAt(index);
  return bytes;
};

const notificationApi = (): typeof Notification | null => {
  try {
    return globalThis.Notification ?? null;
  } catch {
    return null;
  }
};

const serviceWorkerApi = (): ServiceWorkerContainer | null => {
  try {
    return globalThis.navigator?.serviceWorker ?? null;
  } catch {
    return null;
  }
};

const webPushCapability = (): PushCapability => {
  const navigatorApi = globalThis.navigator as (Navigator & { standalone?: boolean }) | undefined;
  if (!navigatorApi) return 'unsupported';
  // iPadOS reports itself as a Mac, so touch points are the only reliable tell.
  const isIOS =
    /iP(hone|ad|od)/.test(navigatorApi.userAgent ?? '') ||
    (navigatorApi.platform === 'MacIntel' && (navigatorApi.maxTouchPoints ?? 0) > 1);
  const isStandalone =
    globalThis.matchMedia?.('(display-mode: standalone)')?.matches === true ||
    navigatorApi.standalone === true;
  return pushCapabilityFrom({
    hasServiceWorker: Boolean(serviceWorkerApi()),
    hasPushManager: 'PushManager' in globalThis,
    isIOS,
    isStandalone,
  });
};

/**
 * What a phone already knows, asked without prompting anybody.
 *
 * Permission alone is not the bargain, exactly as on the web: what holds a
 * place in the queue is a token the server is holding, so a granted permission
 * with no token of ours reports as unasked and offers to fix itself. The token
 * is re-read on every look because the OS is entitled to hand back a different
 * one — after a restore from backup on iOS, and whenever FCM rotates it on
 * Android — and re-posted on every look whether it changed or not, for the
 * reasons on `refreshRegistration`.
 *
 * A permission that has gone is the opposite case, and only this side can see
 * it: see `withdrawRegistration`.
 */
const detectDevice = async (
  transport: NativePushTransport,
  sessionToken: string | null,
): Promise<Partial<PushStore>> => {
  const native = await import('./pushNative');
  if (pushCapabilityFrom(native.nativeFacts(transport)) !== 'ready') {
    return { status: 'unsupported' };
  }

  const permission = await native.nativePermission();
  if (permission !== 'granted') {
    await withdrawRegistration(transport, sessionToken);
    return { status: permission === 'denied' ? 'denied' : 'unasked', endpoint: null };
  }

  if (!readPushEndpoint()) return { status: 'unasked', endpoint: null };
  const token = await native.nativeDeviceToken();
  await refreshRegistration(token, () =>
    savePushDevice(token, transport, identity(sessionToken)),
  );
  return { status: 'granted', endpoint: token, error: null };
};

/**
 * Turn alerts on for a phone.
 *
 * No gesture rule to respect here — that is a web constraint — but the order is
 * the web's anyway: ask, and only register a device whose owner said yes.
 */
const enableDevice = async (
  transport: NativePushTransport,
  sessionToken: string | null,
): Promise<Partial<PushStore>> => {
  const native = await import('./pushNative');
  const permission = await native.requestNativePermission();
  if (permission !== 'granted') {
    return { status: permission === 'denied' ? 'denied' : 'unasked' };
  }
  const token = await native.nativeDeviceToken();
  await savePushDevice(token, transport, identity(sessionToken));
  savePushEndpoint(token);
  return { status: 'granted', endpoint: token, error: null };
};

const identity = (sessionToken: string | null): PushIdentity => ({
  userId: getOrCreateUserId(),
  profileKey: getOrCreateProfileKey(),
  sessionToken,
});

/**
 * Re-post the address this device holds, whether or not it has changed.
 *
 * On every look rather than only when the address moves, because the server's
 * copy can go wrong while the address stays exactly the same. A row belongs to
 * whoever registered it, so signing in here as somebody else — any sign-in the
 * guest merge does not cover — leaves this device summoned for the guest while
 * the account it now plays as looks unreachable. A row the server has dropped
 * is invisible from here too. The upsert moves an address to whoever posted it
 * last, so one request settles both.
 *
 * Only a new address is waited for, because only a new one changes the answer:
 * it is not this device's until the server holds it, and a failure means alerts
 * are not on. One the server held a moment ago very probably still is held, so
 * that request goes on in the background and a failure is not reported. A slow
 * network is no reason to hold the panel at its old answer on every launch, and
 * a blip on the way past is no reason to tell somebody their alerts are off.
 */
const refreshRegistration = async (
  address: string,
  post: () => Promise<unknown>,
): Promise<void> => {
  if (address !== readPushEndpoint()) {
    await post();
    savePushEndpoint(address);
    return;
  }
  void post().catch(() => undefined);
};

/**
 * Take back an address this device registered and can no longer honour.
 *
 * APNs never reports a permission withdrawn in Settings. It goes on accepting
 * every summons for the token, and the phone quietly shows none of them — so a
 * row nobody withdraws holds a place in the queue for ever on the strength of
 * an address that delivers nothing, which is the ghost the away queue must not
 * contain. A browser does get there by itself, when its push service answers
 * 410 at the next send, but only by losing that send.
 *
 * The local copy is cleared only once the server has let go, so a request that
 * fails is made again at the next look instead of forgetting the one address
 * that still needs withdrawing.
 */
const withdrawRegistration = async (
  transport: PushTransport,
  sessionToken: string | null,
): Promise<void> => {
  const known = readPushEndpoint();
  if (!known) return;
  try {
    if (isNative(transport)) await deletePushDevice(known, identity(sessionToken));
    else await deletePushSubscription(known, identity(sessionToken));
    clearPushEndpoint();
  } catch {
    // Kept for the next look. Nothing to tell the player: from their side
    // alerts are already off.
  }
};

export interface PushStore {
  status: PushStatus;
  endpoint: string | null;
  /** A plain-language reason, when something went wrong. */
  error: string | null;
  snoozedUntil: number;
  /** Settle what this device is capable of, and whether it is already set up. */
  detect: (sessionToken: string | null) => Promise<void>;
  /** On the web, must be called straight from a press handler — see below. */
  enable: (sessionToken: string | null) => Promise<void>;
  disable: (sessionToken: string | null) => Promise<void>;
  snoozeOffer: () => void;
}

export const usePushStore = create<PushStore>()((set, get) => ({
  status: 'unsupported',
  endpoint: null,
  error: null,
  snoozedUntil: 0,

  detect: async (sessionToken) => {
    // An enable in flight settles the status itself. On a phone its permission
    // prompt makes the app inactive and then active again, which starts another
    // look, and that look would land in the gap before the token is posted and
    // flash "unasked" over "turning on".
    if (get().status === 'enabling') return;
    set({ snoozedUntil: readAlertsSnoozedUntil() });
    const transport = activePushTransport();
    if (!transport) {
      set({ status: 'unsupported' });
      return;
    }
    if (isNative(transport)) {
      try {
        set(await detectDevice(transport, sessionToken));
      } catch {
        // A failure here must never break matchmaking: the queue still works, it
        // just cannot outlive the app.
        set({ status: 'unasked' });
      }
      return;
    }

    const capability = webPushCapability();
    if (capability !== 'ready') {
      set({ status: capability === 'needs-home-screen' ? 'needs-home-screen' : 'unsupported' });
      return;
    }
    const notification = notificationApi();
    if (!notification) {
      set({ status: 'unsupported' });
      return;
    }
    if (notification.permission !== 'granted') {
      // Blocked, or reset in the site settings, since the last look. The
      // address goes back to the server now rather than at the first summons
      // to fail.
      await withdrawRegistration('web-push', sessionToken);
      set({
        status: notification.permission === 'denied' ? 'denied' : 'unasked',
        endpoint: null,
      });
      return;
    }

    // Permission alone is not the bargain. What holds a place in the queue is a
    // subscription the *server* knows about, so a granted permission with no
    // live subscription reports as unasked and offers to fix itself.
    try {
      const registration = await serviceWorkerApi()?.getRegistration('/');
      const subscription = await registration?.pushManager.getSubscription();
      if (!subscription) {
        // An address this browser no longer holds is one the server must not
        // go on holding either.
        await withdrawRegistration('web-push', sessionToken);
        set({ status: 'unasked', endpoint: null });
        return;
      }
      // Chrome rotates endpoints, and the server's copy can go wrong while the
      // endpoint stays the same, so it is re-posted on every look.
      await refreshRegistration(subscription.endpoint, () =>
        savePushSubscription(payloadFrom(subscription), identity(sessionToken)),
      );
      set({ status: 'granted', endpoint: subscription.endpoint, error: null });
    } catch {
      // A failure here must never break matchmaking: the queue still works,
      // it just cannot outlive the tab.
      set({ status: 'unasked' });
    }
  },

  enable: async (sessionToken) => {
    const transport = activePushTransport();
    if (!transport) {
      set({ status: 'unsupported' });
      return;
    }
    if (isNative(transport)) {
      set({ status: 'enabling', error: null });
      try {
        const enabled = await enableDevice(transport, sessionToken);
        set(enabled);
        if (enabled.status === 'granted') track('alerts_enable', { platform: Platform.OS });
      } catch (error) {
        set({ status: 'error', error: enableFailureMessage(error) });
      }
      return;
    }

    const notification = notificationApi();
    if (!notification) {
      set({ status: 'unsupported' });
      return;
    }
    try {
      // First, and before any `await`. iOS Safari honours a permission request
      // only while it is still inside the gesture that caused it, so a single
      // await ahead of this line means the prompt never appears at all.
      const permission = await notification.requestPermission();
      if (permission !== 'granted') {
        set({ status: permission === 'denied' ? 'denied' : 'unasked' });
        return;
      }
      set({ status: 'enabling', error: null });

      const container = serviceWorkerApi();
      if (!container) {
        set({ status: 'unsupported' });
        return;
      }
      const registration = await container.register('/sw.js', { scope: '/' });
      await container.ready;

      const { enabled, publicKey } = await fetchPushKey();
      if (!enabled || !publicKey) {
        set({ status: 'unasked', error: 'This server is not set up to send alerts yet.' });
        return;
      }
      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey) as BufferSource,
      });
      await savePushSubscription(payloadFrom(subscription), identity(sessionToken));
      savePushEndpoint(subscription.endpoint);
      set({ status: 'granted', endpoint: subscription.endpoint, error: null });
      track('alerts_enable', { platform: 'web' });
    } catch (error) {
      set({ status: 'error', error: enableFailureMessage(error) });
    }
  },

  disable: async (sessionToken) => {
    const endpoint = get().endpoint ?? readPushEndpoint();
    // Dropped locally first and unconditionally. Withdrawing consent is the one
    // request that must never leave somebody still subscribed because a network
    // call failed.
    clearPushEndpoint();
    set({ status: 'unasked', endpoint: null, error: null });
    try {
      const transport = activePushTransport();
      if (transport && isNative(transport)) {
        // The OS permission is deliberately left alone: it is the player's to
        // give and take away, and a phone has nothing to unsubscribe from
        // anyway. Deleting the server's row is what stops the summons.
        if (endpoint) await deletePushDevice(endpoint, identity(sessionToken));
        return;
      }
      const registration = await serviceWorkerApi()?.getRegistration('/');
      const subscription = await registration?.pushManager.getSubscription();
      await subscription?.unsubscribe();
      if (endpoint) await deletePushSubscription(endpoint, identity(sessionToken));
    } catch {
      // Nothing to tell the user: from their side it is already off, and the
      // server prunes a subscription it cannot deliver to anyway.
    }
  },

  snoozeOffer: () => {
    const until = Date.now() + SNOOZE_MS;
    saveAlertsSnoozedUntil(until);
    set({ snoozedUntil: until });
  },
}));

const enableFailureMessage = (error: unknown): string =>
  error instanceof Error
    ? error.message
    : 'Alerts could not be turned on. Your place in the queue still works while this app is open.';

const payloadFrom = (subscription: PushSubscription) => {
  const json = subscription.toJSON();
  return {
    endpoint: subscription.endpoint,
    keys: { p256dh: json.keys?.p256dh ?? '', auth: json.keys?.auth ?? '' },
  };
};

/**
 * Whether the offer to wait with the tab closed is worth making.
 *
 * False once granted (there is nothing to offer), once denied (the button would
 * be a lie — a denied browser resolves `requestPermission` without showing
 * anything), while snoozed, and on a server with no keys.
 */
export const canOfferAlerts = (
  status: PushStatus,
  snoozedUntil: number,
  serverEnabled: boolean,
  nowMs: number,
): boolean => {
  if (!serverEnabled) return false;
  if (status !== 'unasked' && status !== 'error') return false;
  return nowMs >= snoozedUntil;
};
