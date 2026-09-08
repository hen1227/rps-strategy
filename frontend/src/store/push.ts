// Whether this device can be called back, and how it becomes able to be.
//
// Two transports, one state machine. A browser is reached through Web Push and
// an iPhone through APNs, and those have nothing in common on the wire — a URL
// and a pair of encryption keys against a device token — but everything in
// common above it: the same offer, the same statuses, the same one notification,
// and the same rule that what holds a place in the queue is an address the
// *server* knows about. Only `detect`, `enable` and `disable` branch, and the
// iOS half of each lives in `pushApns.ts`.
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
// also why `expo-notifications` is reached through `await import('./pushApns')`
// rather than imported: a native module at module scope would be evaluated by
// the export and by every unit test in this directory.

import { Platform } from 'react-native';
import { create } from 'zustand';

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
export type PushTransport = 'web-push' | 'apns';

/**
 * The transport this build can use, or `null` where the server has no way in.
 *
 * Android is that `null`: it would be FCM, which this server does not speak.
 * Saying so here is what stops an Android build from registering an FCM token
 * on the APNs route and looking reachable for ever while nothing is delivered.
 */
export const activePushTransport = (): PushTransport | null => {
  switch (Platform.OS) {
    case 'web':
      return 'web-push';
    case 'ios':
      return 'apns';
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
  return transport === 'apns' ? support.apns : support.webPush;
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

/** What a native build's capability turns on. */
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
 * The capability decision, as a pure function of a handful of facts about the
 * device, so it can be tested without one.
 */
export const pushCapabilityFrom = (facts: WebPushFacts | ApnsFacts): PushCapability => {
  if (facts.transport === 'apns') {
    if (!facts.hasNotificationsModule || facts.isSimulator) return 'unsupported';
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
 * is re-read on every launch because iOS is entitled to hand back a different
 * one — after a restore from backup, most often — and a stored token nobody
 * re-posts is a subscription that goes quietly stale.
 */
const detectDevice = async (sessionToken: string | null): Promise<Partial<PushStore>> => {
  const apns = await import('./pushApns');
  if (pushCapabilityFrom(apns.apnsFacts()) !== 'ready') return { status: 'unsupported' };

  const permission = await apns.apnsPermission();
  if (permission === 'denied') return { status: 'denied' };
  if (permission !== 'granted') return { status: 'unasked' };

  const known = readPushEndpoint();
  if (!known) return { status: 'unasked', endpoint: null };
  const token = await apns.apnsDeviceToken();
  if (token !== known) {
    await savePushDevice(token, identity(sessionToken));
    savePushEndpoint(token);
  }
  return { status: 'granted', endpoint: token, error: null };
};

/**
 * Turn alerts on for a phone.
 *
 * No gesture rule to respect here — that is a web constraint — but the order is
 * the web's anyway: ask, and only register a device whose owner said yes.
 */
const enableDevice = async (sessionToken: string | null): Promise<Partial<PushStore>> => {
  const apns = await import('./pushApns');
  const permission = await apns.requestApnsPermission();
  if (permission !== 'granted') {
    return { status: permission === 'denied' ? 'denied' : 'unasked' };
  }
  const token = await apns.apnsDeviceToken();
  await savePushDevice(token, identity(sessionToken));
  savePushEndpoint(token);
  return { status: 'granted', endpoint: token, error: null };
};

const identity = (sessionToken: string | null): PushIdentity => ({
  userId: getOrCreateUserId(),
  profileKey: getOrCreateProfileKey(),
  sessionToken,
});

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
    set({ snoozedUntil: readAlertsSnoozedUntil() });
    const transport = activePushTransport();
    if (!transport) {
      set({ status: 'unsupported' });
      return;
    }
    if (transport === 'apns') {
      try {
        set(await detectDevice(sessionToken));
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
    if (notification.permission === 'denied') {
      set({ status: 'denied' });
      return;
    }
    if (notification.permission !== 'granted') {
      set({ status: 'unasked' });
      return;
    }

    // Permission alone is not the bargain. What holds a place in the queue is a
    // subscription the *server* knows about, so a granted permission with no
    // live subscription reports as unasked and offers to fix itself.
    try {
      const registration = await serviceWorkerApi()?.getRegistration('/');
      const subscription = await registration?.pushManager.getSubscription();
      if (!subscription) {
        set({ status: 'unasked', endpoint: null });
        return;
      }
      // Chrome rotates endpoints. Re-posting a changed one silently is what
      // keeps a long-standing subscription from quietly going stale.
      if (subscription.endpoint !== readPushEndpoint()) {
        await savePushSubscription(payloadFrom(subscription), identity(sessionToken));
        savePushEndpoint(subscription.endpoint);
      }
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
    if (transport === 'apns') {
      set({ status: 'enabling', error: null });
      try {
        set(await enableDevice(sessionToken));
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
      if (activePushTransport() === 'apns') {
        // The OS permission is deliberately left alone: it is the player's to
        // give and take away, and iOS has nothing to unsubscribe from anyway.
        // Deleting the server's row is what stops the summons.
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
