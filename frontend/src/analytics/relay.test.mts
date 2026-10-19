import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CLIENT_ID_KEY,
  createRelayTransport,
  FLUSH_DELAY_MS,
  MAX_BATCH,
  SESSION_GAP_MS,
  type RelayBatch,
  type RelayDeps,
} from './relay.ts';

const facts = {
  platform: 'ios',
  appVersion: '1.0.0',
  device: {
    category: 'mobile',
    os: 'iOS',
    osVersion: '18.1',
    model: 'iPhone 15',
    brand: 'Apple',
    language: 'en-GB',
    screen: '1179x2556',
    region: 'GB',
  },
};

/** A phone with a hand-cranked clock, an in-memory store and a recording network. */
const phone = () => {
  let now = 1_760_000_000_000;
  const stored = new Map<string, string>();
  const posted: RelayBatch[] = [];
  const timers = new Map<number, () => void>();
  let nextTimer = 1;
  let foreground: ((active: boolean) => void) | null = null;
  const deps: RelayDeps = {
    now: () => now,
    random: () => 0.5,
    storage: () => ({
      getItem: (key) => stored.get(key) ?? null,
      setItem: (key, value) => void stored.set(key, value),
      removeItem: (key) => void stored.delete(key),
    }),
    post: async (batch) => void posted.push(batch),
    facts: async () => facts,
    onForeground: (listener) => {
      foreground = listener;
      return () => {
        foreground = null;
      };
    },
    setTimer: (callback) => {
      const id = nextTimer++;
      timers.set(id, callback);
      return id;
    },
    clearTimer: (id) => void timers.delete(id as number),
    origin: 'https://rps.example',
    debug: false,
  };
  return {
    deps,
    stored,
    posted,
    advance: (ms: number) => {
      now += ms;
    },
    fireTimers: async () => {
      const due = [...timers.values()];
      timers.clear();
      for (const callback of due) callback();
      await new Promise((resolve) => setImmediate(resolve));
    },
    setForeground: async (active: boolean) => {
      foreground?.(active);
      await new Promise((resolve) => setImmediate(resolve));
    },
    get listening() {
      return foreground !== null;
    },
  };
};

test('events wait for company, then go in one batch under one client ID', async () => {
  const device = phone();
  const relay = createRelayTransport(device.deps);
  relay.start();
  relay.send('page_view', {}, '/');
  device.advance(2_000);
  relay.send('queue_join', { mode: 'V6' }, '/');
  assert.equal(device.posted.length, 0, 'sent before the batch window closed');

  await device.fireTimers();
  assert.equal(device.posted.length, 1);
  const [batch] = device.posted;
  assert.match(batch.clientId, /^\d+\.\d+$/);
  assert.equal(device.stored.get(CLIENT_ID_KEY), batch.clientId);
  assert.equal(batch.platform, 'ios');
  assert.deepEqual(batch.events.map((event) => event.name), ['page_view', 'queue_join']);
  const [view, join] = batch.events;
  assert.equal(view.params.page_location, 'https://rps.example/');
  assert.equal(join.params.mode, 'V6');
  assert.equal(join.params.session_id, view.params.session_id);
  // Two seconds in front of the player between the two events.
  assert.equal(join.params.engagement_time_msec, 2_000);
  assert.ok(Number(view.params.engagement_time_msec) >= 1, 'an event with no engagement is not an active user');
});

test('a full batch goes at once', async () => {
  const device = phone();
  const relay = createRelayTransport(device.deps);
  relay.start();
  for (let index = 0; index < MAX_BATCH; index++) relay.send('page_view', {}, '/');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(device.posted.length, 1);
  assert.equal(device.posted[0].events.length, MAX_BATCH);
});

test('putting the app away sends what is waiting', async () => {
  const device = phone();
  const relay = createRelayTransport(device.deps);
  relay.start();
  relay.send('page_view', {}, '/');
  await device.setForeground(false);
  assert.equal(device.posted.length, 1);
});

test('half an hour away is a new session; a minute is not', async () => {
  const device = phone();
  const relay = createRelayTransport(device.deps);
  relay.start();
  relay.send('page_view', {}, '/');
  await device.setForeground(false);
  device.advance(60_000);
  await device.setForeground(true);
  relay.send('page_view', {}, '/');
  await device.setForeground(false);
  device.advance(SESSION_GAP_MS);
  await device.setForeground(true);
  relay.send('page_view', {}, '/');
  await device.fireTimers();

  const sessions = device.posted.flatMap((batch) => batch.events.map((event) => event.params.session_id));
  assert.equal(sessions.length, 3);
  assert.equal(sessions[0], sessions[1]);
  assert.notEqual(sessions[1], sessions[2]);
});

// Turning stats off forgets this install, so turning them on again later is
// somebody new rather than the same visitor with a gap.
test('withdrawing consent drops what is waiting and forgets the client ID', async () => {
  const device = phone();
  const relay = createRelayTransport(device.deps);
  relay.start();
  relay.send('page_view', {}, '/');
  relay.stop();
  await device.fireTimers();
  assert.equal(device.posted.length, 0);
  assert.equal(device.stored.has(CLIENT_ID_KEY), false);
  assert.equal(device.listening, false);

  relay.send('page_view', {}, '/');
  await device.fireTimers();
  assert.equal(device.posted.length, 0, 'sent while stopped');
});

test('a batch that fails is dropped rather than retried', async () => {
  const device = phone();
  let attempts = 0;
  const relay = createRelayTransport({
    ...device.deps,
    post: async () => {
      attempts++;
      throw new TypeError('offline');
    },
  });
  relay.start();
  relay.send('page_view', {}, '/');
  await device.fireTimers();
  device.advance(FLUSH_DELAY_MS);
  await device.fireTimers();
  assert.equal(attempts, 1);
});
