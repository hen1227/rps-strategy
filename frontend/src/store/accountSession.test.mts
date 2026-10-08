import assert from 'node:assert/strict';
import test from 'node:test';

import { createSessionSlice, type SessionSlice } from './accountSession.ts';
import type { Account } from '../types/protocol.ts';

// The slice is driven directly rather than through `useGameStore`, the same way
// `localSession.test.mts` and `botSession.test.mts` do it: a `StateCreator` is a
// function of `set` and `get`, so a plain object is a whole store.
//
// `fetch` is replaced rather than mocked at the module boundary, because what
// is under test is how a *reply shape* is read — the naming step can answer
// with a session or with a further question, and the branch between them is the
// thing that used to be missing.

interface Harness {
  profileKey: string | null;
  account: Account | null;
  applyAccountUpdate: (account: Account | null) => void;
}

type Store = SessionSlice & Harness;
type Setter = (patch: Partial<Store> | ((current: Store) => Partial<Store>)) => void;
type Getter = () => Store;

const account: Account = {
  userId: 'legacy',
  username: 'Ada',
  registered: true,
  elo: 1500,
} as Account;

const openStore = (reply: unknown) => {
  const calls: Array<Record<string, unknown>> = [];
  globalThis.fetch = (async (_url: string, options: { body?: string }) => {
    calls.push(JSON.parse(options.body ?? '{}') as Record<string, unknown>);
    return {
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      json: async () => reply,
    };
  }) as unknown as typeof fetch;

  let state = {} as Store;
  const set: Setter = (patch) => {
    state = { ...state, ...(typeof patch === 'function' ? patch(state) : patch) };
  };
  const get: Getter = () => state;
  const create = createSessionSlice as unknown as (
    set: Setter,
    get: Getter,
    api: unknown,
  ) => SessionSlice;

  state = {
    ...create(set, get, {}),
    // The slice reads a token out of device storage as it is created, and the
    // store under Node has one, written by whichever test ran last. Cleared so
    // each test starts signed out and "is there a session now" means this test.
    sessionToken: null,
    profileKey: null,
    account: null,
    applyAccountUpdate: (next) => set({ account: next }),
  };
  return { get, set, calls };
};

test('a name that is already an account asks for its password instead of failing', async () => {
  const { get, set } = openStore({ needsPassword: true, suggestedUsername: 'Ada' });
  set({ pendingSignup: { ticket: 'rps_t_x', provider: 'discord', suggestedUsername: 'Yuki', discordHandle: 'yuki' } });

  // Somebody whose account predates Discord types the name they have always
  // had. This used to throw "that username is already taken", which is true
  // and no use to them: the name is their own.
  const outcome = await get().claimUsername('rps_t_x', 'Ada');

  assert.equal(outcome, null, 'a question is not an account');
  assert.equal(get().pendingSignup?.claimingUsername, 'Ada');
  // The ticket survives, so answering costs no second trip through Discord.
  assert.equal(get().pendingSignup?.ticket, 'rps_t_x');
  assert.equal(get().sessionToken, null);
});

test('the password finishes the step and adopts the account that already existed', async () => {
  const { get, set, calls } = openStore({ token: 'rps_s_abc', account });
  set({
    pendingSignup: {
      ticket: 'rps_t_x',
      provider: 'discord',
      suggestedUsername: 'Yuki',
      discordHandle: 'yuki',
      claimingUsername: 'Ada',
    },
  });

  const outcome = await get().claimUsername('rps_t_x', 'Ada', 'her-password');

  assert.equal(outcome?.userId, 'legacy', 'she keeps the account she had');
  assert.equal(get().sessionToken, 'rps_s_abc');
  assert.equal(get().pendingSignup, null);
  assert.equal(calls.at(-1)?.password, 'her-password');
});

test('an ordinary signup sends no password and still adopts its session', async () => {
  const { get, set, calls } = openStore({ token: 'rps_s_new', account });
  set({ pendingSignup: { ticket: 'rps_t_x', provider: 'discord', suggestedUsername: 'Yuki', discordHandle: 'yuki' } });

  await get().claimUsername('rps_t_x', 'Yuki');

  assert.equal(get().sessionToken, 'rps_s_new');
  assert.equal(calls.at(-1)?.password, '');
});

// A reply with neither a session nor a question is a server that has changed
// under the app. Throwing is right: `adoptSession(undefined, undefined)` would
// sign somebody in as nobody.
test('a reply with neither a session nor a question is a failure', async () => {
  const { get, set } = openStore({});
  set({ pendingSignup: { ticket: 'rps_t_x', provider: 'discord', suggestedUsername: 'Yuki', discordHandle: 'yuki' } });

  await assert.rejects(() => get().claimUsername('rps_t_x', 'Yuki'), /did not complete/);
  assert.equal(get().sessionToken, null);
});

// Apple on the phone redeems its ticket inside the same call, so the ticket the
// naming step needs comes back in the reply rather than from an address bar.
test('an Apple sign-in that needs a name keeps the ticket the server sent', async () => {
  const { get } = openStore({
    needsUsername: true,
    provider: 'apple',
    ticket: 'rps_t_apple',
  });
  // The web half's redemption, standing in for the reply path both share.
  const outcome = await get().redeemSignInTicket('rps_t_from_the_url');

  assert.equal(outcome.kind, 'unnamed');
  assert.equal(get().pendingSignup?.provider, 'apple');
  assert.equal(get().pendingSignup?.ticket, 'rps_t_apple');
  // Apple gives no name to suggest from, and the field starts empty.
  assert.equal(get().pendingSignup?.suggestedUsername, '');
});

// A failed redemption used to throw, and the button waiting on it spun for good.
test('a ticket the server refuses is a failure with words, not an exception', async () => {
  const { get } = openStore({ error: 'that sign-in has expired; try again' });
  globalThis.fetch = (async () => ({
    ok: false,
    status: 401,
    headers: { get: () => 'application/json' },
    json: async () => ({ error: 'that sign-in has expired; try again' }),
  })) as unknown as typeof fetch;

  const outcome = await get().redeemSignInTicket('rps_t_x');
  assert.deepEqual(outcome, { kind: 'failed', message: 'that sign-in has expired; try again' });
});

// Signing in upgrades this device's guest in place, so the account keeps the
// device's key. Signing out has to leave the device with a guest that key does
// not open, or the phone goes on playing as the account it says it left.
test("signing out of this device's own upgraded account gives the device a new guest", async () => {
  const { getOrCreateUserId, getOrCreateProfileKey } = await import('./localIdentity.ts');
  const { get, set } = openStore({});
  const before = getOrCreateUserId();
  const beforeKey = getOrCreateProfileKey();
  set({ sessionToken: 'rps_s_x', account: { ...account, userId: before } });

  get().clearSession();

  assert.notEqual(getOrCreateUserId(), before);
  assert.notEqual(getOrCreateProfileKey(), beforeKey);
  assert.equal(get().profileKey, getOrCreateProfileKey(), 'the socket reconnects with the new key');
  assert.equal(get().account, null);
});

test('signing out of an account made on another device keeps this one', async () => {
  const { getOrCreateUserId } = await import('./localIdentity.ts');
  const { get, set } = openStore({});
  const before = getOrCreateUserId();
  set({ sessionToken: 'rps_s_x', account: { ...account, userId: 'made-elsewhere' } });

  get().clearSession();

  assert.equal(getOrCreateUserId(), before, 'this device was never that account');
});

// A session refused at launch is refused before the lobby has said whose it
// was, so the account is not in the store yet. What was stored with the token
// says it, or the device would reconnect with a key that still opens the
// account it just lost — or, deleted elsewhere, opens nothing at all.
test('a session refused before the lobby answered still leaves the device a new guest', async () => {
  const { getOrCreateUserId } = await import('./localIdentity.ts');
  const { get, set } = openStore({});
  const before = getOrCreateUserId();
  // Signed in on this device, upgrading its own guest, in some earlier launch.
  get().adoptSession('rps_s_x', { ...account, userId: before });
  // This launch: nothing from the lobby yet when the server refuses the token.
  set({ account: null });

  get().clearSession();

  assert.notEqual(getOrCreateUserId(), before);
});
