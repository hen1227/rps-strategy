import type { AnalyticsParams } from './events';
import type { AnalyticsTransport } from './transport.types';

// The apps' half: events batched to this server, which forwards them to Google.
//
// The apps have no tag, and the Measurement Protocol needs an API secret that
// cannot ship inside a public app. So the phone posts to POST /api/analytics
// and the server adds the secret (backend/internal/server/google_analytics.go).
// Google is never handed the phone's address, only the server's.
//
// What gtag.js does for the website by itself, this has to do by hand, and it
// does the three things reports are built on:
//
//   - **A client ID** per install, in the two-numbers-and-a-dot shape Google
//     uses, kept in device storage. Withdrawing consent deletes it, so turning
//     stats back on later is a new, unrelated visitor.
//   - **A session**, numbered by the second it began, that ends after half an
//     hour in the background — Google's own rule for the web.
//   - **Engagement time**: how long the app was in front of the player since
//     the last event. An event carrying some is what makes a user "active".
//
// Batched, because a phone's radio is the expensive part: an event waits up to
// a quarter of a minute for company, and everything waiting is sent the moment
// the app is put away. A batch that fails is dropped. These are counts, and a
// retry queue that outlives a subway ride is more machinery than they are worth.
//
// Every platform API arrives through `RelayDeps`, so the logic can be tested
// in Node and the wiring lives in `transport.ts`.

export const CLIENT_ID_KEY = 'rps.analyticsClient.v1';
export const FLUSH_DELAY_MS = 15_000;
export const MAX_BATCH = 25;
export const SESSION_GAP_MS = 30 * 60_000;

export interface RelayDevice {
  category: string;
  os: string;
  osVersion: string;
  model: string;
  brand: string;
  language: string;
  screen: string;
  region: string;
}

export interface RelayFacts {
  platform: string;
  appVersion: string;
  device: RelayDevice;
}

export interface RelayEvent {
  name: string;
  params: Record<string, string | number>;
  timeMs: number;
}

export interface RelayBatch extends RelayFacts {
  clientId: string;
  events: RelayEvent[];
}

export interface RelayDeps {
  now(): number;
  random(): number;
  storage(): { getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem(key: string): void } | null;
  post(batch: RelayBatch): Promise<void>;
  facts(): Promise<RelayFacts>;
  /** Calls back with true when the app comes to the front and false when it leaves. Returns the unsubscribe. */
  onForeground(listener: (foreground: boolean) => void): () => void;
  setTimer(callback: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  /** The website's origin, so a page reads the same in a report from either half. */
  origin: string;
  debug: boolean;
}

export const createRelayTransport = (deps: RelayDeps): AnalyticsTransport & { flush(): Promise<void> } => {
  let running = false;
  let clientId: string | null = null;
  let queue: RelayEvent[] = [];
  let timer: unknown = null;
  let unsubscribe: (() => void) | null = null;

  let sessionId = '';
  let foregroundSince: number | null = null;
  let engagedMs = 0;
  let backgroundedAt: number | null = null;

  const readClientId = (): string => {
    const store = deps.storage();
    try {
      const stored = store?.getItem(CLIENT_ID_KEY);
      if (stored && /^\d+\.\d+$/.test(stored)) return stored;
    } catch {
      // Unreadable storage is a new visitor every launch, which is the honest
      // count of what this device lets us remember.
    }
    const minted = `${Math.floor(deps.random() * 2_147_483_647)}.${Math.floor(deps.now() / 1000)}`;
    try {
      store?.setItem(CLIENT_ID_KEY, minted);
    } catch {
      // As above.
    }
    return minted;
  };

  const beginSession = () => {
    sessionId = String(Math.floor(deps.now() / 1000));
  };

  /** Foreground time since the last event, which this event now carries. */
  const takeEngagement = (): number => {
    const now = deps.now();
    let total = engagedMs;
    if (foregroundSince !== null) {
      total += now - foregroundSince;
      foregroundSince = now;
    }
    engagedMs = 0;
    return Math.max(1, Math.round(total));
  };

  const flush = async () => {
    if (timer !== null) {
      deps.clearTimer(timer);
      timer = null;
    }
    if (!running || !clientId || queue.length === 0) return;
    const events = queue.splice(0, MAX_BATCH);
    try {
      const facts = await deps.facts();
      await deps.post({ ...facts, clientId, events });
    } catch {
      // Dropped; see the header.
    }
    if (queue.length > 0) schedule();
  };

  const schedule = () => {
    if (timer === null) timer = deps.setTimer(() => void flush(), FLUSH_DELAY_MS);
  };

  const onForeground = (foreground: boolean) => {
    const now = deps.now();
    if (foreground) {
      if (backgroundedAt !== null && now - backgroundedAt >= SESSION_GAP_MS) beginSession();
      backgroundedAt = null;
      if (foregroundSince === null) foregroundSince = now;
      return;
    }
    if (foregroundSince !== null) engagedMs += now - foregroundSince;
    foregroundSince = null;
    backgroundedAt = now;
    void flush();
  };

  return {
    start() {
      if (running) return;
      running = true;
      clientId = readClientId();
      beginSession();
      foregroundSince = deps.now();
      engagedMs = 0;
      backgroundedAt = null;
      unsubscribe = deps.onForeground(onForeground);
    },

    stop() {
      if (!running) return;
      running = false;
      queue = [];
      if (timer !== null) deps.clearTimer(timer);
      timer = null;
      unsubscribe?.();
      unsubscribe = null;
      clientId = null;
      try {
        deps.storage()?.removeItem(CLIENT_ID_KEY);
      } catch {
        // Nothing more can be done about storage that will not write.
      }
    },

    send(name: string, params: AnalyticsParams, location: string) {
      if (!running) return;
      const event: RelayEvent = {
        name,
        params: {
          ...params,
          page_location: `${deps.origin}${location}`,
          page_title: location,
          session_id: sessionId,
          engagement_time_msec: takeEngagement(),
          ...(deps.debug ? { debug_mode: 1 } : {}),
        },
        timeMs: deps.now(),
      };
      queue.push(event);
      if (queue.length >= MAX_BATCH) void flush();
      else schedule();
    },

    flush,
  };
};
