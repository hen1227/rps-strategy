// Whether this browser can be called back, and how it becomes able to be.
//
// A store of its own rather than a slice of the game store, following
// `bottomInset` and `reviewHandoff`: nothing in the game store needs push, and
// keeping it out means the socket and the `GameStore` union are untouched.
// `useQueueCall` reads both and hands the combination to `queueSelectors`,
// which is what lets that module stay pure.
//
// Every browser API here is reached inside a function, never at module scope.
// This file is imported during the static export, which runs in Node with no
// `window`, no `navigator` and no `Notification` — the same rule
// `localIdentity.ts` follows for `localStorage`, and for the same reason.

import { create } from 'zustand';

import {
  deletePushSubscription,
  fetchPushKey,
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
  /** No service worker or no push manager: nothing to offer. */
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

/**
 * The capability decision, as a pure function of four facts about the browser,
 * so it can be tested without one.
 */
export const pushCapabilityFrom = (facts: {
  hasServiceWorker: boolean;
  hasPushManager: boolean;
  isIOS: boolean;
  isStandalone: boolean;
}): PushCapability => {
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

const pushCapability = (): PushCapability => {
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
  /** Settle what this browser is capable of, and whether it is already set up. */
  detect: (sessionToken: string | null) => Promise<void>;
  /** Must be called straight from a press handler — see below. */
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
    const capability = pushCapability();
    set({ snoozedUntil: readAlertsSnoozedUntil() });
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
      set({
        status: 'error',
        error:
          error instanceof Error
            ? error.message
            : 'Alerts could not be turned on. Your place in the queue still works while this tab is open.',
      });
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
