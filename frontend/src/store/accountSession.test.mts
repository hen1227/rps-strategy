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
  set({ pendingDiscordSignup: { ticket: 'rps_t_x', suggestedUsername: 'Yuki', discordHandle: 'yuki' } });

  // Somebody whose account predates Discord types the name they have always
  // had. This used to throw "that username is already taken", which is true
  // and no use to them: the name is their own.
  const outcome = await get().claimDiscordUsername('rps_t_x', 'Ada');

  assert.equal(outcome, null, 'a question is not an account');
  assert.equal(get().pendingDiscordSignup?.claimingUsername, 'Ada');
  // The ticket survives, so answering costs no second trip through Discord.
  assert.equal(get().pendingDiscordSignup?.ticket, 'rps_t_x');
  assert.equal(get().sessionToken, null);
});

test('the password finishes the step and adopts the account that already existed', async () => {
  const { get, set, calls } = openStore({ token: 'rps_s_abc', account });
  set({
    pendingDiscordSignup: {
      ticket: 'rps_t_x',
      suggestedUsername: 'Yuki',
      discordHandle: 'yuki',
      claimingUsername: 'Ada',
    },
  });

  const outcome = await get().claimDiscordUsername('rps_t_x', 'Ada', 'her-password');

  assert.equal(outcome?.userId, 'legacy', 'she keeps the account she had');
  assert.equal(get().sessionToken, 'rps_s_abc');
  assert.equal(get().pendingDiscordSignup, null);
  assert.equal(calls.at(-1)?.password, 'her-password');
});

test('an ordinary signup sends no password and still adopts its session', async () => {
  const { get, set, calls } = openStore({ token: 'rps_s_new', account });
  set({ pendingDiscordSignup: { ticket: 'rps_t_x', suggestedUsername: 'Yuki', discordHandle: 'yuki' } });

  await get().claimDiscordUsername('rps_t_x', 'Yuki');

  assert.equal(get().sessionToken, 'rps_s_new');
  assert.equal(calls.at(-1)?.password, '');
});

// A reply with neither a session nor a question is a server that has changed
// under the app. Throwing is right: `adoptSession(undefined, undefined)` would
// sign somebody in as nobody.
test('a reply with neither a session nor a question is a failure', async () => {
  const { get, set } = openStore({});
  set({ pendingDiscordSignup: { ticket: 'rps_t_x', suggestedUsername: 'Yuki', discordHandle: 'yuki' } });

  await assert.rejects(() => get().claimDiscordUsername('rps_t_x', 'Yuki'), /did not complete/);
  assert.equal(get().sessionToken, null);
});
