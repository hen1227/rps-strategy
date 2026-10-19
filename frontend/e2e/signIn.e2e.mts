// Sign-in, end to end: the app's own sign-in code against the real server.
//
// The route tests in `backend/internal/server` prove each route, and
// `src/store/accountSession.test.mts` proves how the store reads each reply.
// Neither proves the two agree — that the app asks for routes the server has,
// in the order it expects, with the credentials it expects. That is what an
// iPad beta found out the hard way: "Use my account" signed in with Discord,
// then posted the held Apple ticket to `POST /api/auth/link` on a production
// server deployed before that route existed, and showed "404 page not found".
//
// So this runs the store — `accountSession.ts`, and the phone's halves of both
// providers in `appleAuth.ts` and `discordAuth.ts` — against the server's own
// handlers and a real database, served by `TestServeSignInFixture`. Apple's and
// Discord's servers are the fakes the Go tests use, which sign and check real
// tokens; Apple's sheet and the system browser are stood in for by
// `e2e/loader.mjs`. Every request in between is the real one.
//
// `npm run test:e2e`. It needs Go, to build the server's test binary.

import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import type { SessionSlice } from '../src/store/accountSession.ts';
import type { Account } from '../src/types/protocol.ts';

const BACKEND = fileURLToPath(new URL('../../backend/', import.meta.url));

interface Harness {
  profileKey: string;
  account: Account | null;
  applyAccountUpdate: (account: Account | null) => void;
}
type Phone = SessionSlice & Harness;
type Setter = (patch: Partial<Phone> | ((current: Phone) => Partial<Phone>)) => void;
type Getter = () => Phone;
type Creator = (set: Setter, get: Getter, api: unknown) => SessionSlice;

/** Who is signed in to Discord in the browser, as Discord's API spells it. */
interface DiscordUser {
  id: string;
  username: string;
  global_name: string;
}

let fixture: ChildProcess | null = null;
let base = '';
let scratch = '';
let createSessionSlice: Creator;
let identity: typeof import('../src/store/localIdentity.ts');

/** What the phone's sheets do, which the test decides. */
const device = {
  /** The Apple ID Apple's sheet signs in as. */
  appleId: '',
  /** Whether the next trip through the browser is cancelled instead. */
  cancelBrowser: false,
};

const fixturePost = async (path: string, body: unknown): Promise<unknown> => {
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${path}: ${response.status} ${await response.text()}`);
  return response.status === 204 ? null : response.json();
};

/**
 * The system browser of `openAuthSessionAsync`: it follows Discord's consent
 * and the server's callback, and hands back the address the app is called
 * with, which is where `ASWebAuthenticationSession` stops.
 */
const browser = async (url: string, redirectUrl: string) => {
  if (device.cancelBrowser) return { type: 'cancel' };
  let next = url;
  for (let hop = 0; hop < 6; hop += 1) {
    const response = await fetch(next, { redirect: 'manual' });
    const location = response.headers.get('location');
    if (!location) {
      throw new Error(`the browser stopped at ${next} (${response.status}): ${await response.text()}`);
    }
    if (location.startsWith(redirectUrl)) return { type: 'success', url: location };
    next = new URL(location, next).href;
  }
  throw new Error('the browser went round in circles');
};

/** Apple's sheet: a token Apple signed over this nonce, and a one-time code. */
const appleSheet = async ({ nonce }: { nonce?: string }) => {
  const reply = (await fixturePost('/fixture/apple/sheet', { nonce, sub: device.appleId })) as {
    identityToken: string;
    authorizationCode: string;
  };
  return { user: device.appleId, ...reply };
};

before(
  async () => {
    scratch = mkdtempSync(join(tmpdir(), 'rps-signin-e2e-'));
    const binary = join(scratch, 'server.test');
    execFileSync('go', ['test', '-c', '-o', binary, './internal/server'], {
      cwd: BACKEND,
      stdio: 'inherit',
    });
    const child = spawn(binary, ['-test.run', '^TestServeSignInFixture$'], {
      cwd: join(BACKEND, 'internal', 'server'),
      env: { ...process.env, RPS_SIGNIN_FIXTURE: '1' },
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    fixture = child;
    base = await new Promise<string>((resolve, reject) => {
      createInterface({ input: child.stdout! }).on('line', (line) => {
        const served = /^RPS_SIGNIN_FIXTURE_URL=(\S+)$/.exec(line);
        if (served) resolve(served[1]!);
      });
      child.once('exit', (code) => reject(new Error(`the fixture exited (${code}) before serving`)));
    });

    // The app reads its server's address as its modules load, so nothing of
    // it is imported until the fixture has one.
    process.env.EXPO_PUBLIC_API_URL = base;
    ({ createSessionSlice } = (await import('../src/store/accountSession.ts')) as unknown as {
      createSessionSlice: Creator;
    });
    identity = await import('../src/store/localIdentity.ts');
    (globalThis as Record<string, unknown>).__signInE2E = { appleSheet, browser };
  },
  { timeout: 300_000 },
);

after(async () => {
  const child = fixture;
  if (child && child.exitCode === null) {
    const exited = new Promise((resolve) => child.once('exit', resolve));
    child.stdin?.end();
    const timer = setTimeout(() => child.kill(), 5_000);
    await exited;
    clearTimeout(timer);
  }
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

/**
 * A phone: a guest of its own, registered the way the lobby socket registers
 * one, and the app's sign-in store. Phones here share one device store, so each
 * starts by taking a new identity in it — one phone at a time.
 */
const openPhone = async () => {
  const guest = identity.replaceDeviceIdentity();
  let state = {} as Phone;
  const set: Setter = (patch) => {
    state = { ...state, ...(typeof patch === 'function' ? patch(state) : patch) };
  };
  const get: Getter = () => state;
  state = {
    ...createSessionSlice(set, get, {}),
    // Read from the device store as the slice is made; a new phone has none.
    sessionToken: null,
    pendingSignup: null,
    carriedSignIn: null,
    signInReceipt: null,
    signInReturnTo: null,
    profileKey: guest.profileKey,
    account: null,
    applyAccountUpdate: (account) => set({ account }),
  };
  await fixturePost('/fixture/guest', guest);
  return {
    get,
    /** Sign out, and register whichever guest the device is left as. */
    signOut: async () => {
      await get().signOut();
      await fixturePost('/fixture/guest', {
        userId: identity.getOrCreateUserId(),
        profileKey: get().profileKey,
      });
    },
  };
};

const signedInToDiscord = (user: DiscordUser) => fixturePost('/fixture/discord/user', user);

/** An account somebody made earlier on another phone, with Discord. */
const discordAccount = async (user: DiscordUser, name: string): Promise<Account> => {
  const phone = await openPhone();
  await signedInToDiscord(user);
  const first = await phone.get().signInWithDiscord();
  assert.equal(first.kind, 'unnamed', `a Discord account the server has not seen: ${JSON.stringify(first)}`);
  const made = await phone.get().claimUsername(phone.get().pendingSignup!.ticket, name);
  assert.ok(made, 'the name was taken');
  return made;
};

/** The same, made with Apple. */
const appleAccount = async (appleId: string, name: string): Promise<Account> => {
  const phone = await openPhone();
  device.appleId = appleId;
  const first = await phone.get().signInWithApple();
  assert.equal(first.kind, 'unnamed', `an Apple ID the server has not seen: ${JSON.stringify(first)}`);
  const made = await phone.get().claimUsername(phone.get().pendingSignup!.ticket, name);
  assert.ok(made, 'the name was taken');
  return made;
};

// The iPad's first attempt, against a server that has the route: a new Apple
// ID, "First time here?", "Use my account", Discord — and both are one account.
test('a new Apple ID joins the Discord account signed into next', async () => {
  const yuki: DiscordUser = { id: '900000000000000001', username: 'yuki', global_name: 'Yuki' };
  const made = await discordAccount(yuki, 'Yukimura');

  const ipad = await openPhone();
  device.appleId = '000111.e2e0000000000000000000000000001.0001';
  const apple = await ipad.get().signInWithApple();
  assert.equal(apple.kind, 'unnamed', 'the Apple ID is new, so the naming step opens');
  assert.equal(ipad.get().pendingSignup?.provider, 'apple');

  await signedInToDiscord(yuki);
  const outcome = await ipad.get().continueWithOther('discord');

  assert.equal(outcome.kind, 'named');
  assert.equal(ipad.get().account?.userId, made.userId, 'signed in to the Discord account');
  assert.deepEqual(ipad.get().signInReceipt, { kind: 'signedIn', linked: ['apple'] });
  assert.equal(ipad.get().carriedSignIn, null);
  assert.equal(ipad.get().pendingSignup, null);

  // And from now on the Apple ID opens that account by itself.
  await ipad.signOut();
  const again = await ipad.get().signInWithApple();
  assert.equal(again.kind, 'named', 'no naming step the second time');
  assert.equal(ipad.get().account?.userId, made.userId);
});

// The iPad's actual night: the same presses against a server from before the
// link route. The sign-in lands, the receipt says what to press, and pressing
// it — Apple again, now from the session — links, as the second attempt did.
test('against a server without the link route, the button on the last step links', async () => {
  const kai: DiscordUser = { id: '900000000000000002', username: 'kai', global_name: 'Kai' };
  const made = await discordAccount(kai, 'Kaimana');
  await fixturePost('/fixture/link-route', { served: false });
  try {
    const ipad = await openPhone();
    device.appleId = '000111.e2e0000000000000000000000000002.0002';
    assert.equal((await ipad.get().signInWithApple()).kind, 'unnamed');
    await signedInToDiscord(kai);

    const outcome = await ipad.get().continueWithOther('discord');

    assert.equal(outcome.kind, 'named', 'the sign-in itself still works');
    assert.equal(ipad.get().account?.userId, made.userId);
    assert.deepEqual(ipad.get().signInReceipt, {
      kind: 'signedIn',
      linked: [],
      linkFailure: { provider: 'apple', message: 'link it with the Apple button below' },
    });

    const linked = await ipad.get().signInWithApple();
    assert.equal(linked.kind, 'named');
    assert.equal(ipad.get().account?.userId, made.userId);
    assert.deepEqual(ipad.get().signInReceipt, { kind: 'signedIn', linked: ['apple'] });

    await ipad.signOut();
    assert.equal((await ipad.get().signInWithApple()).kind, 'named');
    assert.equal(ipad.get().account?.userId, made.userId);
  } finally {
    await fixturePost('/fixture/link-route', { served: true });
  }
});

// The other way round: the account was made with Apple, and Discord is new.
test('a new Discord joins the Apple account signed into next', async () => {
  const appleId = '000111.e2e0000000000000000000000000003.0003';
  const made = await appleAccount(appleId, 'Juniper');

  const phone = await openPhone();
  const juni: DiscordUser = { id: '900000000000000003', username: 'juni', global_name: 'Juni' };
  await signedInToDiscord(juni);
  assert.equal((await phone.get().signInWithDiscord()).kind, 'unnamed');

  device.appleId = appleId;
  const outcome = await phone.get().continueWithOther('apple');

  assert.equal(outcome.kind, 'named');
  assert.equal(phone.get().account?.userId, made.userId);
  assert.deepEqual(phone.get().signInReceipt, { kind: 'signedIn', linked: ['discord'] });

  await phone.signOut();
  await signedInToDiscord(juni);
  assert.equal((await phone.get().signInWithDiscord()).kind, 'named');
  assert.equal(phone.get().account?.userId, made.userId);
});

// An account that already has a Discord of its own cannot take a second. The
// sign-in still lands, and the receipt carries the server's reason.
test('a link the server refuses still signs in, with the reason', async () => {
  const appleId = '000111.e2e0000000000000000000000000004.0004';
  const theirs: DiscordUser = { id: '900000000000000004', username: 'ash', global_name: 'Ash' };
  const made = await appleAccount(appleId, 'Ashgrove');
  {
    // Discord linked to it from a session, on the phone that made it.
    const owner = await openPhone();
    device.appleId = appleId;
    assert.equal((await owner.get().signInWithApple()).kind, 'named');
    await signedInToDiscord(theirs);
    assert.equal((await owner.get().signInWithDiscord()).kind, 'named');
  }

  const phone = await openPhone();
  await signedInToDiscord({ id: '900000000000000005', username: 'rowan', global_name: 'Rowan' });
  assert.equal((await phone.get().signInWithDiscord()).kind, 'unnamed');
  device.appleId = appleId;
  const outcome = await phone.get().continueWithOther('apple');

  assert.equal(outcome.kind, 'named');
  assert.equal(phone.get().account?.userId, made.userId);
  const receipt = phone.get().signInReceipt;
  assert.equal(receipt?.linkFailure?.provider, 'discord');
  assert.match(receipt?.linkFailure?.message ?? '', /Discord/);
  assert.deepEqual(receipt?.linked, []);
});

// Backing out of the second sign-in returns to the naming step as it was.
test('a cancelled second sign-in leaves the naming step as it was', async () => {
  const phone = await openPhone();
  device.appleId = '000111.e2e0000000000000000000000000006.0006';
  assert.equal((await phone.get().signInWithApple()).kind, 'unnamed');
  const pending = phone.get().pendingSignup;

  device.cancelBrowser = true;
  try {
    assert.equal((await phone.get().continueWithOther('discord')).kind, 'cancelled');
  } finally {
    device.cancelBrowser = false;
  }

  assert.equal(phone.get().carriedSignIn, null);
  assert.deepEqual(phone.get().pendingSignup, pending);
  assert.equal(phone.get().sessionToken, null);
  // And the step can still be finished as a new account.
  const made = await phone.get().claimUsername(pending!.ticket, 'Larchmont');
  assert.equal(made?.username, 'Larchmont');
});
