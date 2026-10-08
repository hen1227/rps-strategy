import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';

import { Platform } from 'react-native';

import {
  clearPushEndpoint,
  getOrCreateProfileKey,
  readPushEndpoint,
  savePushEndpoint,
} from './localIdentity.ts';
import { usePushStore } from './push.ts';

// What a look does to the server's copy of this device's address. A browser is
// the half Node can stand in for: everything it reads is a global. The phone's
// half runs the same two helpers behind `expo-notifications`, which Node does
// not have.
//
// This file pretends to be a browser for its whole run, which is why it is not
// part of `push.test.mts`: Node gives each test file a process of its own.

const ENDPOINT = 'https://push.example.com/browser-a';
const ROTATED = 'https://push.example.com/browser-b';

type Answer = 'ok' | 'error' | 'offline';

interface Call {
  method: string;
  path: string;
  url: string;
  body: unknown;
  authorization: string | null;
}

interface FakeBrowser {
  calls: Call[];
  /** How the server answers from here on. */
  server: Answer;
}

const define = (name: string, value: unknown) =>
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });

/**
 * A browser with the given permission and live subscription, talking to a
 * server that answers as `server` says.
 */
const fakeBrowser = ({
  permission,
  subscription = null,
  server = 'ok',
}: {
  permission: 'granted' | 'denied' | 'default';
  subscription?: string | null;
  server?: Answer;
}): FakeBrowser => {
  const browser: FakeBrowser = { calls: [], server };
  const pushSubscription = subscription
    ? {
        endpoint: subscription,
        toJSON: () => ({ endpoint: subscription, keys: { p256dh: 'p256dh', auth: 'auth' } }),
      }
    : null;
  define('Notification', { permission });
  define('PushManager', class {});
  define('navigator', {
    userAgent: 'node-test',
    serviceWorker: {
      getRegistration: async () => ({
        pushManager: { getSubscription: async () => pushSubscription },
      }),
    },
  });
  define('fetch', async (input: string | URL, init: RequestInit = {}) => {
    const url = String(input);
    const headers = new Headers(init.headers);
    browser.calls.push({
      method: init.method ?? 'GET',
      path: new URL(url).pathname,
      url,
      body: typeof init.body === 'string' ? JSON.parse(init.body) : null,
      authorization: headers.get('Authorization'),
    });
    if (browser.server === 'offline') throw new TypeError('fetch failed');
    const failed = browser.server === 'error';
    return new Response(JSON.stringify(failed ? { error: 'down' } : { subscribed: true }), {
      status: failed ? 500 : 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  return browser;
};

const detect = (sessionToken: string | null = null) =>
  usePushStore.getState().detect(sessionToken);

const status = () => usePushStore.getState().status;

const requests = (browser: FakeBrowser) =>
  browser.calls.map((call) => `${call.method} ${call.path}`);

beforeEach(() => {
  Object.assign(Platform, { OS: 'web' });
  usePushStore.setState({ status: 'unsupported', endpoint: null, error: null });
  clearPushEndpoint();
});

test('a browser that never turned alerts on asks the server nothing', async () => {
  const browser = fakeBrowser({ permission: 'default' });
  await detect();
  assert.equal(status(), 'unasked');
  assert.deepEqual(requests(browser), []);
});

// The ghost this exists to prevent: a permission withdrawn since the last look,
// with the server still counting this browser as a way to call somebody back.
test('a browser that has blocked alerts takes its address back from the server', async () => {
  const browser = fakeBrowser({ permission: 'denied' });
  savePushEndpoint(ENDPOINT);
  await detect();
  assert.equal(status(), 'denied');
  assert.deepEqual(requests(browser), ['DELETE /api/push/subscriptions']);
  assert.deepEqual(browser.calls[0].body, { endpoint: ENDPOINT });
  assert.equal(readPushEndpoint(), null);
});

test('a withdrawal that fails is made again at the next look', async () => {
  const browser = fakeBrowser({ permission: 'denied', server: 'offline' });
  savePushEndpoint(ENDPOINT);
  await detect();
  assert.equal(status(), 'denied');
  // Forgetting it here would leave the one address that still needs
  // withdrawing with nobody left who knows it.
  assert.equal(readPushEndpoint(), ENDPOINT);

  browser.server = 'ok';
  await detect();
  assert.deepEqual(requests(browser), [
    'DELETE /api/push/subscriptions',
    'DELETE /api/push/subscriptions',
  ]);
  assert.equal(readPushEndpoint(), null);
});

test('an address this browser no longer holds is withdrawn too', async () => {
  const browser = fakeBrowser({ permission: 'granted', subscription: null });
  savePushEndpoint(ENDPOINT);
  await detect();
  assert.equal(status(), 'unasked');
  assert.deepEqual(requests(browser), ['DELETE /api/push/subscriptions']);
  assert.equal(readPushEndpoint(), null);
});

// The account switch: the row belongs to whoever posted it last, so a look made
// as somebody new is what moves this browser's summons to them.
test('a granted browser re-posts its address on every look, as whoever is asking', async () => {
  const browser = fakeBrowser({ permission: 'granted', subscription: ENDPOINT });
  savePushEndpoint(ENDPOINT);

  await detect();
  await detect('session-of-the-account-signed-into');

  assert.equal(status(), 'granted');
  assert.deepEqual(requests(browser), [
    'POST /api/push/subscriptions',
    'POST /api/push/subscriptions',
  ]);
  assert.equal(browser.calls[0].authorization, `Bearer ${getOrCreateProfileKey()}`);
  assert.match(browser.calls[0].url, /\?userId=/);
  assert.equal(browser.calls[1].authorization, 'Bearer session-of-the-account-signed-into');
  assert.deepEqual(browser.calls[1].body, {
    endpoint: ENDPOINT,
    keys: { p256dh: 'p256dh', auth: 'auth' },
  });
});

test('a refresh that fails leaves alerts on when the server already had the address', async () => {
  fakeBrowser({ permission: 'granted', subscription: ENDPOINT, server: 'error' });
  savePushEndpoint(ENDPOINT);
  await detect();
  assert.equal(status(), 'granted');
  assert.equal(readPushEndpoint(), ENDPOINT);
});

test('a new address the server would not take is not reported as on', async () => {
  fakeBrowser({ permission: 'granted', subscription: ROTATED, server: 'error' });
  savePushEndpoint(ENDPOINT);
  await detect();
  assert.equal(status(), 'unasked');
  assert.equal(readPushEndpoint(), ENDPOINT);
});

test('a look while alerts are being turned on leaves that to finish', async () => {
  const browser = fakeBrowser({ permission: 'granted', subscription: ENDPOINT });
  savePushEndpoint(ENDPOINT);
  usePushStore.setState({ status: 'enabling' });
  await detect();
  assert.equal(status(), 'enabling');
  assert.deepEqual(requests(browser), []);
});
