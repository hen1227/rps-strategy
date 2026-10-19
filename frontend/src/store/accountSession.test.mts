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
    // The same for the sign-in flow, which the slice reads back from storage.
    pendingSignup: null,
    carriedSignIn: null,
    signInReturnTo: null,
    signInReceipt: null,
    applyAccountUpdate: (next) => set({ account: next }),
  };
  return { get, set, calls };
};

/** A reply per route, for the tests where one sign-in makes two calls. */
interface RoutedCall {
  path: string;
  authorization: string | null;
  body: Record<string, unknown>;
}

const routeReplies = (replies: Record<string, { status?: number; body: unknown }>) => {
  const calls: RoutedCall[] = [];
  globalThis.fetch = (async (
    url: string,
    options: { body?: string; headers?: Record<string, string> },
  ) => {
    const path = new URL(url).pathname;
    calls.push({
      path,
      authorization: options.headers?.Authorization ?? null,
      body: JSON.parse(options.body ?? '{}') as Record<string, unknown>,
    });
    const reply = replies[path] ?? { status: 404, body: { error: 'no such route' } };
    const status = reply.status ?? 200;
    return {
      ok: status < 400,
      status,
      headers: { get: () => 'application/json' },
      json: async () => reply.body,
    };
  }) as unknown as typeof fetch;
  return calls;
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

// On Android the browser's return reaches the waiting sign-in and the router's
// callback page alike, so the same ticket is redeemed twice. The server spends
// it on the first exchange; the second must share that answer, not fail.
test('a ticket redeemed twice is exchanged once and both callers hear the same answer', async () => {
  const { get, calls } = openStore({ token: 'rps_s_once', account });

  const first = get().redeemSignInTicket('rps_t_twice');
  const second = get().redeemSignInTicket('rps_t_twice');
  const [early, late] = await Promise.all([first, second]);
  // The callback page mounts a render later, after the first answer is in.
  const later = await get().redeemSignInTicket('rps_t_twice');

  assert.equal(calls.length, 1);
  assert.equal(early.kind, 'named');
  assert.deepEqual(late, early);
  assert.deepEqual(later, early);
  assert.equal(get().sessionToken, 'rps_s_once');
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

// The naming step's "I already have an account". The Apple ID was new, its
// owner plays under Discord, and the Apple ticket is held while they sign in
// with Discord. The account Discord opens gets Apple too, in the same press.
test('a sign-in that lands in an existing account links the identity it carried', async () => {
  const { get, set } = openStore({});
  const linkedAccount = { ...account, updatedAtUnixMs: 2 } as Account;
  const calls = routeReplies({
    '/api/auth/discord/exchange': { body: { token: 'rps_s_d', account, provider: 'discord' } },
    '/api/auth/link': { body: { account: linkedAccount, provider: 'apple' } },
  });
  set({
    pendingSignup: { ticket: 'rps_t_apple', provider: 'apple', suggestedUsername: '', discordHandle: '' },
    carriedSignIn: { ticket: 'rps_t_apple', provider: 'apple' },
  });

  const outcome = await get().redeemSignInTicket('rps_t_discord');

  assert.equal(outcome.kind, 'named');
  const link = calls.find((call) => call.path === '/api/auth/link');
  assert.equal(link?.body.ticket, 'rps_t_apple');
  assert.equal(link?.authorization, 'Bearer rps_s_d', 'linked with the session just made');
  assert.deepEqual(get().signInReceipt, { kind: 'signedIn', linked: ['apple'] });
  assert.equal(get().account, linkedAccount, 'adopted as it stands after the link');
  assert.equal(get().sessionToken, 'rps_s_d');
  assert.equal(get().pendingSignup, null);
  assert.equal(get().carriedSignIn, null);
});

// The link can be refused — that account already has a different Apple ID. The
// sign-in it rode on still worked, and the receipt says what did not.
test('a refused link still signs in, and the receipt says why', async () => {
  const { get, set } = openStore({});
  routeReplies({
    '/api/auth/discord/exchange': { body: { token: 'rps_s_d', account } },
    '/api/auth/link': {
      status: 409,
      body: { error: 'this account is already linked to a different Apple ID' },
    },
  });
  set({ carriedSignIn: { ticket: 'rps_t_apple', provider: 'apple' } });

  const outcome = await get().redeemSignInTicket('rps_t_discord');

  assert.equal(outcome.kind, 'named');
  assert.equal(get().sessionToken, 'rps_s_d');
  assert.deepEqual(get().signInReceipt, {
    kind: 'signedIn',
    linked: [],
    linkFailure: {
      provider: 'apple',
      message: 'this account is already linked to a different Apple ID',
    },
  });
  assert.equal(get().carriedSignIn, null, 'nothing is left waiting to be linked');
});

// Discord turned out to be new as well. The naming step comes back for it,
// still carrying Apple, and the account it makes holds both.
test('an identity carried into a second new one joins the account the step makes', async () => {
  const { get, set } = openStore({});
  const calls = routeReplies({
    '/api/auth/discord/exchange': {
      body: { needsUsername: true, provider: 'discord', suggestedUsername: 'Yuki', discordHandle: 'yuki' },
    },
    '/api/auth/discord/complete': { body: { token: 'rps_s_new', account } },
    '/api/auth/link': { body: { account } },
  });
  set({ carriedSignIn: { ticket: 'rps_t_apple', provider: 'apple' } });

  const outcome = await get().redeemSignInTicket('rps_t_discord');
  assert.equal(outcome.kind, 'unnamed');
  assert.equal(get().pendingSignup?.ticket, 'rps_t_discord');
  assert.equal(get().carriedSignIn?.ticket, 'rps_t_apple', 'still carried into the new step');

  await get().claimUsername('rps_t_discord', 'Yuki');

  assert.equal(calls.find((call) => call.path === '/api/auth/link')?.body.ticket, 'rps_t_apple');
  assert.deepEqual(get().signInReceipt, { kind: 'created', linked: ['apple'] });
});

// Pressed Discord, came straight back with the browser's Back button, and
// finished the step they had left: the carried ticket is the one just spent.
test('a carried ticket the sign-in itself spent is not linked again', async () => {
  const { get, set } = openStore({});
  const calls = routeReplies({ '/api/auth/discord/complete': { body: { token: 'rps_s_new', account } } });
  set({
    pendingSignup: { ticket: 'rps_t_apple', provider: 'apple', suggestedUsername: '', discordHandle: '' },
    carriedSignIn: { ticket: 'rps_t_apple', provider: 'apple' },
  });

  await get().claimUsername('rps_t_apple', 'Orchard');

  assert.equal(calls.some((call) => call.path === '/api/auth/link'), false);
  assert.deepEqual(get().signInReceipt, { kind: 'created', linked: [] });
});

// "Add Apple" pressed on the step that has just said "account created" is a
// link from a session. It adds to that receipt rather than replacing it with
// one that says "welcome back".
test('a link made from a session adds to the receipt showing', async () => {
  const { get, set } = openStore({});
  routeReplies({
    '/api/auth/discord/exchange': { body: { token: 'rps_s_two', account, provider: 'apple' } },
  });
  set({
    sessionToken: 'rps_s_one',
    account,
    signInReceipt: { kind: 'created', linked: [] },
  });

  const outcome = await get().redeemSignInTicket('rps_t_apple_web');

  assert.equal(outcome.kind, 'named');
  assert.deepEqual(get().signInReceipt, { kind: 'created', linked: ['apple'] });
  assert.equal(get().sessionToken, 'rps_s_two');
});

// On the web, the second sign-in is a full-page redirect. What the naming step
// held has to be there when the page comes back.
test('the sign-in flow survives the page being reloaded', async () => {
  const first = openStore({});
  routeReplies({
    '/api/auth/discord/exchange': {
      body: { needsUsername: true, provider: 'apple', ticket: 'rps_t_apple' },
    },
  });
  await first.get().redeemSignInTicket('rps_t_from_the_url');
  first.get().setSignInReturnTo('/tournaments?tournament=t1');

  // A new page: the slice made again, reading what the last one stored.
  const { createSessionSlice: create } = await import('./accountSession.ts');
  const restored = (create as unknown as (s: unknown, g: unknown, a: unknown) => SessionSlice)(
    () => {},
    () => ({}),
    {},
  );
  assert.equal(restored.pendingSignup?.ticket, 'rps_t_apple');
  assert.equal(restored.signInReturnTo, '/tournaments?tournament=t1');

  first.get().dismissSignup();
  first.get().setSignInReturnTo(null);
  const cleared = (create as unknown as (s: unknown, g: unknown, a: unknown) => SessionSlice)(
    () => {},
    () => ({}),
    {},
  );
  assert.equal(cleared.pendingSignup, null);
  assert.equal(cleared.signInReturnTo, null);
});

test('only a path inside the app is a place to come back to', async () => {
  const { safeReturnPath } = await import('./accountSession.ts');
  assert.equal(safeReturnPath('/bots'), '/bots');
  assert.equal(safeReturnPath('/tournaments?tournament=t1'), '/tournaments?tournament=t1');
  assert.equal(safeReturnPath('//evil.example/x'), null);
  assert.equal(safeReturnPath('https://evil.example'), null);
  assert.equal(safeReturnPath(''), null);
  assert.equal(safeReturnPath(undefined), null);
});

// Back from a web redirect, the callback page redeems before the lobby has said
// whose session this is. The id stored with the token answers instead, so
// "add Apple" on the Account screen is still read as a link, which that
// screen's own list confirms, and not as a sign-in to announce.
test('a link from a session is recognised before the lobby has answered', async () => {
  const { get, set } = openStore({});
  get().adoptSession('rps_s_one', account);
  set({ account: null, signInReceipt: null });
  routeReplies({
    '/api/auth/discord/exchange': { body: { token: 'rps_s_two', account, provider: 'apple' } },
  });

  await get().redeemSignInTicket('rps_t_apple_web');

  const { receiptWorthShowing } = await import('./accountSession.ts');
  assert.deepEqual(get().signInReceipt, { kind: 'linked', linked: ['apple'] });
  assert.equal(receiptWorthShowing(get().signInReceipt), false);
});

// A server deployed before the link route existed answers it the way Go's
// router answers any path it does not have: a plain-text "404 page not found".
// An iPad beta reached production in exactly that state, and showed the raw
// text. The sign-in under it worked and must still land; the receipt should
// say how to link instead — the provider's button on the same screen, which
// links from the session and which every server understands.
test('a server without the link route still signs in, and says how to link instead', async () => {
  const { get, set } = openStore({});
  globalThis.fetch = (async (url: string) => {
    const path = new URL(url).pathname;
    if (path === '/api/auth/discord/exchange') {
      return {
        ok: true,
        status: 200,
        headers: { get: () => 'application/json' },
        json: async () => ({ token: 'rps_s_d', account, provider: 'discord' }),
      };
    }
    return {
      ok: false,
      status: 404,
      headers: { get: () => 'text/plain; charset=utf-8' },
      text: async () => '404 page not found\n',
    };
  }) as unknown as typeof fetch;
  set({
    pendingSignup: { ticket: 'rps_t_apple', provider: 'apple', suggestedUsername: '', discordHandle: '' },
    carriedSignIn: { ticket: 'rps_t_apple', provider: 'apple' },
  });

  const outcome = await get().redeemSignInTicket('rps_t_discord');

  assert.equal(outcome.kind, 'named');
  assert.equal(get().sessionToken, 'rps_s_d', 'signed in all the same');
  assert.deepEqual(get().signInReceipt, {
    kind: 'signedIn',
    linked: [],
    linkFailure: { provider: 'apple', message: 'link it with the Apple button below' },
  });
  assert.equal(get().carriedSignIn, null);
  assert.equal(get().pendingSignup, null);
});

// "Use my account" pressed, and the other provider's sign-in could not even
// start — here because Node has no browser module, the same answer a binary
// without it gives. Nothing is left carried, and the naming step is as it was,
// so pressing "Create an account" next makes an account with only its own
// identity rather than linking a ticket nobody chose to link.
test('a second sign-in that cannot start leaves the naming step as it was', async () => {
  const { get, set } = openStore({});
  const pending = {
    ticket: 'rps_t_apple',
    provider: 'apple' as const,
    suggestedUsername: '',
    discordHandle: '',
  };
  set({ pendingSignup: pending });

  const outcome = await get().continueWithOther('discord');

  assert.equal(outcome.kind, 'failed');
  assert.equal(get().carriedSignIn, null);
  assert.deepEqual(get().pendingSignup, pending);
  assert.equal(get().sessionToken, null);
});
