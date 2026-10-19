import {
  completeSignup,
  exchangeSignInTicket,
  finishAppleNativeAuth,
  linkSignInTicket,
  loginAccount,
  logoutAccount,
  startAppleNativeAuth,
  startAppleWebAuth,
  startDiscordAuth,
  type SignInProvider,
  type SignInReply,
} from './api/bots';
import { ApiError } from './api/http';
import { isAppleSignInAvailable, signInThroughApple } from './appleAuth';
import { isDiscordSignInAvailable, signInThroughDiscord } from './discordAuth';
import { type DiscordOutcome } from './discordAuth.types';
import { deviceStorage } from './deviceStorage';
import { getOrCreateUserId, replaceDeviceIdentity } from './localIdentity';
import type { GameStore } from './types';
import { track } from '@/analytics/track';
import { failureMessage } from '@/errors';
import type { Account } from '@/types/protocol';
import type { StateCreator } from 'zustand';

// The signed-in session: one token, in one place.
//
// It lives in the store rather than in the screen that collects the password
// because two other things need it. The WebSocket authenticates with it, so a
// signed-in player is themselves on any browser or device they open; and the
// bot panel cannot list anything without it.
//
// Everything here goes through `applyAccountUpdate`, which reconnects the
// socket. Signing in that does not change who you are in the lobby would be
// the confusing half-measure.
//
// Two providers reach it: Discord, and Apple beside it. They start differently
// — a browser for Discord everywhere and for Apple on the website, Apple's own
// sheet on the phone — and finish identically, in a reply that is a session, a
// request for a name, or a request for an older account's password.
//
// A sign-in can also carry a second identity into the account it lands in. That
// is the naming step's "I already have an account": the Apple ID is new, its
// owner plays under Discord, so the Apple ticket is held while they sign in with
// Discord and is linked to that account as soon as there is one. On the web the
// Discord half is a full-page redirect, so the flow is written to device
// storage and read back when the page returns.

const SESSION_TOKEN_KEY = 'rps.sessionToken.v1';

const readSessionToken = (): string | null => {
  try {
    return deviceStorage()?.getItem(SESSION_TOKEN_KEY) ?? null;
  } catch {
    return null;
  }
};

const writeSessionToken = (token: string | null) => {
  try {
    if (token) deviceStorage()?.setItem(SESSION_TOKEN_KEY, token);
    else deviceStorage()?.removeItem(SESSION_TOKEN_KEY);
  } catch {
    // Private browsing, or a device store that will not open: the session
    // lasts as long as this one does.
  }
};

// Whose session the stored token is, kept beside it. The server can refuse a
// session — expired, revoked, the account deleted from another device — before
// it has said whose it was, and `clearSession` has to know whether the account
// being left is this device's own. See there.
const SESSION_ACCOUNT_KEY = 'rps.sessionAccountId.v1';

const readSessionAccountId = (): string | null => {
  try {
    return deviceStorage()?.getItem(SESSION_ACCOUNT_KEY) ?? null;
  } catch {
    return null;
  }
};

const writeSessionAccountId = (userId: string | null) => {
  try {
    if (userId) deviceStorage()?.setItem(SESSION_ACCOUNT_KEY, userId);
    else deviceStorage()?.removeItem(SESSION_ACCOUNT_KEY);
  } catch {
    // Without it, a session refused before the lobby answered is left the way
    // every session used to be left: with this device's key.
  }
};

// The sign-in under way, kept beside the session: the identity waiting for a
// name, the one being carried into the next sign-in, what the last one did, and
// the page to go back to once it is over. Written on every change and read when the store is made, so
// a web redirect to Discord or Apple, or a reload in the middle of choosing a
// name, comes back to the same step.
//
// It lasts as long as the server keeps a ticket waiting for its name. After
// that the tickets in it are dead, and a step built on them could only fail.
const SIGN_IN_FLOW_KEY = 'rps.signInFlow.v1';
const SIGN_IN_FLOW_LIFETIME_MS = 10 * 60 * 1000;

interface SignInFlow {
  pendingSignup: PendingSignup | null;
  carriedSignIn: CarriedSignIn | null;
  signInReceipt: SignInReceipt | null;
  signInReturnTo: string | null;
}

const NO_FLOW: SignInFlow = {
  pendingSignup: null,
  carriedSignIn: null,
  signInReceipt: null,
  signInReturnTo: null,
};

const readSignInFlow = (now = Date.now()): SignInFlow => {
  try {
    const stored = deviceStorage()?.getItem(SIGN_IN_FLOW_KEY);
    if (!stored) return NO_FLOW;
    const parsed = JSON.parse(stored) as Partial<SignInFlow> & { savedAt?: number };
    if (typeof parsed.savedAt !== 'number' || now - parsed.savedAt > SIGN_IN_FLOW_LIFETIME_MS) {
      deviceStorage()?.removeItem(SIGN_IN_FLOW_KEY);
      return NO_FLOW;
    }
    return {
      pendingSignup: parsed.pendingSignup?.ticket ? parsed.pendingSignup : null,
      carriedSignIn: parsed.carriedSignIn?.ticket ? parsed.carriedSignIn : null,
      signInReceipt: Array.isArray(parsed.signInReceipt?.linked) ? parsed.signInReceipt : null,
      signInReturnTo: safeReturnPath(parsed.signInReturnTo),
    };
  } catch {
    return NO_FLOW;
  }
};

const writeSignInFlow = (flow: SignInFlow) => {
  try {
    if (!flow.pendingSignup && !flow.carriedSignIn && !flow.signInReceipt && !flow.signInReturnTo) {
      deviceStorage()?.removeItem(SIGN_IN_FLOW_KEY);
    } else {
      deviceStorage()?.setItem(SIGN_IN_FLOW_KEY, JSON.stringify({ ...flow, savedAt: Date.now() }));
    }
  } catch {
    // The flow then lasts as long as this page does, which on a phone is all
    // of it. Only a web redirect loses it, and that costs one more press.
  }
};

/**
 * Why a held sign-in was not linked, in words that say what to do next.
 *
 * A server older than `POST /api/auth/link` answers it with Go's bare
 * "404 page not found", which is what a beta build on an iPad showed when it
 * reached a production server deployed before the route existed. The sign-in
 * itself had worked; only the link had nowhere to go. The last step lists the provider's
 * own button under this, and pressing it there links from the session — a
 * request every server version understands — so that is what to say.
 */
const linkFailureMessage = (caught: unknown, provider: SignInProvider): string =>
  caught instanceof ApiError && caught.status === 404
    ? `link it with the ${provider === 'apple' ? 'Apple' : 'Discord'} button below`
    : failureMessage(caught, 'That sign-in could not be linked.');

/**
 * A page inside this app to go back to, or null.
 *
 * The return path arrives in a query string, so it is somebody else's text
 * until checked: a path, and not an address on another site.
 */
export const safeReturnPath = (path: unknown): string | null =>
  typeof path === 'string' && path.startsWith('/') && !path.startsWith('//') ? path : null;

/**
 * An identity held while the player signs in another way.
 *
 * Linked to whichever account that sign-in lands in, which is what lets a new
 * Apple ID join the Discord account its owner already has in one step.
 */
export interface CarriedSignIn {
  ticket: string;
  provider: SignInProvider;
}

/** What the last finished sign-in did, for the screen that says so. */
export interface SignInReceipt {
  /**
   * A new account, one that already existed, or a second way into the account
   * that was already signed in — "add Apple" on the Account screen.
   */
  kind: 'created' | 'signedIn' | 'linked';
  /** Identities linked on top of the one the sign-in went through. */
  linked: SignInProvider[];
  /** A link that was tried and refused, in the server's words. */
  linkFailure?: { provider: SignInProvider; message: string };
}

/**
 * Whether a receipt says anything the account page would not.
 *
 * A returning player signing in is not news; they go straight back to where
 * they were. A new account, or a sign-in that brought a second way in with it,
 * is shown once. A link pressed on the Account screen is not either: that
 * screen's own list already says so.
 */
export const receiptWorthShowing = (receipt: SignInReceipt | null): boolean =>
  Boolean(
    receipt &&
      receipt.kind !== 'linked' &&
      (receipt.kind === 'created' || receipt.linked.length > 0 || receipt.linkFailure),
  );

/**
 * What a sign-in produced once the provider had answered.
 *
 * `named` means there is a session and nothing else to do. `unnamed` means the
 * player is new and still has to agree a username; the ticket stays live for
 * that second step. `pending` is a web redirect having been issued, and
 * nothing after it runs.
 */
export type SignInOutcome =
  | { kind: 'named'; account: Account; receipt: SignInReceipt }
  | ({ kind: 'unnamed' } & PendingSignup)
  | { kind: 'pending' }
  | { kind: 'cancelled' }
  | { kind: 'failed'; message: string };

export type NamedOutcome = Extract<SignInOutcome, { kind: 'named' }>;

/** A signup that has proved who it is and still needs a name. */
export interface PendingSignup {
  ticket: string;
  /** Who vouched for it, which the naming step says. */
  provider: SignInProvider;
  /** Empty for Apple, which offers no name to suggest one from. */
  suggestedUsername: string;
  discordHandle: string;
  /**
   * Set once the server has said the name on the form belongs to an account
   * made before Discord sign-in. The step is then no longer "pick a name" but
   * "prove this one is yours", and the panel needs a password field.
   *
   * On the pending signup rather than in the panel's own state because the
   * ticket is what it belongs to: it survives the panel remounting, and it is
   * cleared by the next name the player tries.
   */
  claimingUsername?: string;
}

export interface SessionSlice {
  sessionToken: string | null;
  /**
   * Set when a provider has vouched for somebody who has no account here yet.
   *
   * In the store rather than passed between screens because the platforms
   * arrive at it from different directions: the web build redeems its ticket
   * on the callback page and then navigates, while the phone redeems in place
   * when the sheet closes. Parking it here means one panel handles every one.
   */
  pendingSignup: PendingSignup | null;
  /**
   * An identity to link to whichever account the next sign-in lands in. Set
   * by `continueWithOther`, from the naming step; see `CarriedSignIn`.
   */
  carriedSignIn: CarriedSignIn | null;
  /**
   * What the last sign-in did, until the screen that shows it is left. Kept
   * through a web redirect too, for "add Apple" pressed on that screen.
   */
  signInReceipt: SignInReceipt | null;
  /**
   * The page to go back to when the sign-in is over: the one whose "sign in"
   * button started it. Kept through a web redirect, like the rest of the flow.
   */
  signInReturnTo: string | null;
  setSignInReturnTo: (path: string | null) => void;
  clearSignInReceipt: () => void;
  /** Leave the naming step: drop its ticket, and anything carried with it. */
  dismissSignup: () => void;
  /** A second sign-in that did not finish: nothing waits to be linked now. */
  dropCarriedSignIn: () => void;
  /**
   * The naming step's "I already have an account": sign in with the other
   * provider, carrying this step's identity into the account that finds.
   */
  continueWithOther: (provider: SignInProvider) => Promise<SignInOutcome>;
  /** Whether this build can offer Discord at all. See `discordAuth.types`. */
  discordSignInAvailable: boolean;
  /**
   * Whether this build can offer Apple at all. See `appleAuth.types` — and
   * `useSignInProviders`, for whether the server can complete it.
   */
  appleSignInAvailable: boolean;
  signInWithDiscord: () => Promise<SignInOutcome>;
  signInWithApple: () => Promise<SignInOutcome>;
  /** Redeem a ticket the browser came back with. The web half's second step. */
  redeemSignInTicket: (ticket: string) => Promise<SignInOutcome>;
  /**
   * Finish the naming step.
   *
   * Resolves to the account when it is done. Resolves to null when the server
   * has asked for a password instead — the name given is an older account's,
   * and `pendingSignup.claimingUsername` now says which. The ticket is still
   * live either way, so nothing is lost by answering.
   */
  claimUsername: (
    ticket: string,
    username: string,
    password?: string,
    reservationToken?: string,
  ) => Promise<Account | null>;
  /** The password sign-in older accounts still have. Throws when refused. */
  signIn: (username: string, password: string) => Promise<NamedOutcome>;
  signOut: () => Promise<void>;
  adoptSession: (token: string, account: Account) => Account;
  clearSession: () => void;
}

/**
 * Whether somebody is signed in as a real account.
 *
 * One definition, because this now gates ranked play as well as the account
 * screen and the title picker, and three copies of a rule that decides whether
 * a game counts is two too many.
 */
export const isSignedIn = (
  sessionToken: string | null,
  account: Account | null | undefined,
) => Boolean(sessionToken && account?.registered);

export const createSessionSlice: StateCreator<GameStore, [], [], SessionSlice> = (set, get) => {
  // Who is asking, for a sign-in that is starting. A session token when there
  // is one, which is how a signed-in player adds a second way in rather than
  // starting again. Otherwise the local key, which proves the guest whose
  // history the sign-in may keep — the same proof registering used to need.
  const requester = () => ({
    userId: getOrCreateUserId(),
    credential: get().sessionToken ?? get().profileKey,
  });

  // One exchange per ticket, shared by everybody who asks. On Android the
  // browser hands its return address to the app as an ordinary link, so the
  // router opens the callback page with the same ticket the waiting sign-in is
  // already redeeming. A ticket is spent the first time, and a second exchange
  // would paint an error over a sign-in that worked. Kept once settled, because
  // the page mounts after the first answer has arrived.
  const redemptions = new Map<string, Promise<SignInOutcome>>();

  // Every change to the flow goes through here, so what is stored is always
  // what is on screen.
  const setFlow = (patch: Partial<SignInFlow>) => {
    set(patch);
    const state = get();
    writeSignInFlow({
      pendingSignup: state.pendingSignup,
      carriedSignIn: state.carriedSignIn,
      signInReceipt: state.signInReceipt,
      signInReturnTo: state.signInReturnTo,
    });
  };

  // A sign-in has landed in an account. Link whatever it carried, then adopt
  // the session once, with the account as it now stands, so the lobby socket
  // reconnects one time rather than twice.
  //
  // `spent` is the ticket this sign-in itself used up. A carried ticket can be
  // the same one — the player pressed Discord, came straight back with the
  // browser's back button, and finished the naming step they had left — and
  // linking it again could only fail.
  //
  // A sign-in started from a session on the same account was a link, not a
  // sign-in: "add Apple" on the Account screen, or on the step that has just
  // said "account created". It adds to the receipt already showing rather
  // than replacing it with one that says "welcome back".
  const settle = async (
    token: string,
    account: Account,
    kind: SignInReceipt['kind'],
    linked: SignInProvider[],
    spent: string,
  ): Promise<{ account: Account; receipt: SignInReceipt }> => {
    const carried = get().carriedSignIn;
    const receipt: SignInReceipt = { kind, linked };
    let landed = account;
    if (carried && carried.ticket !== spent) {
      try {
        const reply = await linkSignInTicket(token, carried.ticket);
        if (reply.account) landed = reply.account;
        receipt.linked = [...receipt.linked, carried.provider];
      } catch (caught) {
        receipt.linkFailure = {
          provider: carried.provider,
          message: linkFailureMessage(caught, carried.provider),
        };
      }
    }
    setFlow({ pendingSignup: null, carriedSignIn: null, signInReceipt: receipt });
    return { account: get().adoptSession(token, landed), receipt };
  };

  // The receipt for a link made from a session: the one showing, plus this.
  const linkedFromSession = (provider: SignInProvider | undefined) => {
    const shown = get().signInReceipt ?? { kind: 'linked' as const, linked: [] };
    const receipt: SignInReceipt = {
      kind: shown.kind,
      linked: provider ? [...shown.linked, provider] : shown.linked,
    };
    setFlow({ signInReceipt: receipt });
    return receipt;
  };

  // The one reading of a finished sign-in, whichever provider it came from.
  const acceptReply = async (reply: SignInReply, ticket: string): Promise<SignInOutcome> => {
    if (reply.needsUsername) {
      const pending: PendingSignup = {
        ticket: reply.ticket || ticket,
        provider: reply.provider ?? 'discord',
        suggestedUsername: reply.suggestedUsername ?? '',
        discordHandle: reply.discordHandle ?? '',
      };
      setFlow({ pendingSignup: pending });
      return { kind: 'unnamed', ...pending };
    }
    if (!reply.token || !reply.account) {
      return { kind: 'failed', message: 'That sign-in did not complete. Try again.' };
    }
    track('login', { method: reply.provider ?? 'unknown' });
    // Whose session this is: the lobby's answer, or, back from a web redirect
    // before the lobby has said anything, what was stored with the token.
    const sessionOwner = get().account?.userId ?? readSessionAccountId();
    if (get().sessionToken && sessionOwner === reply.account.userId) {
      const receipt = linkedFromSession(reply.provider);
      return { kind: 'named', account: get().adoptSession(reply.token, reply.account), receipt };
    }
    const settled = await settle(reply.token, reply.account, 'signedIn', [], reply.ticket || ticket);
    return { kind: 'named', ...settled };
  };

  const restored = readSignInFlow();

  return {
    sessionToken: readSessionToken(),

    discordSignInAvailable: isDiscordSignInAvailable(),
    appleSignInAvailable: isAppleSignInAvailable(),
    ...restored,

    setSignInReturnTo: (path) => setFlow({ signInReturnTo: safeReturnPath(path) }),
    clearSignInReceipt: () => {
      if (get().signInReceipt) setFlow({ signInReceipt: null });
    },

    // Dropping the ticket is the only way out of the naming step, and it costs
    // the player nothing but another trip through the provider: no account was
    // created and no name was held.
    dismissSignup: () => setFlow({ pendingSignup: null, carriedSignIn: null }),
    dropCarriedSignIn: () => {
      if (get().carriedSignIn) setFlow({ carriedSignIn: null });
    },

    // Carried only for as long as the second sign-in is out. Backing out of it
    // returns to the naming step as it was, with nothing waiting to be linked.
    continueWithOther: async (provider) => {
      const pending = get().pendingSignup;
      if (pending && pending.provider !== provider) {
        setFlow({ carriedSignIn: { ticket: pending.ticket, provider: pending.provider } });
      }
      const outcome =
        provider === 'apple' ? await get().signInWithApple() : await get().signInWithDiscord();
      if (outcome.kind === 'cancelled' || outcome.kind === 'failed') {
        setFlow({ carriedSignIn: null });
      }
      return outcome;
    },

    // Signing in upgrades this device's anonymous account in place where it
    // can, keeping the rating, the record and the games.
    signInWithDiscord: async () => {
      const outcome: DiscordOutcome = await signInThroughDiscord((redirectUri) =>
        startDiscordAuth(redirectUri, requester()).then((reply) => reply.authorizeUrl),
      );
      switch (outcome.kind) {
        case 'ticket':
          return get().redeemSignInTicket(outcome.ticket);
        case 'pending':
          // The browser is navigating away, so nothing after this runs.
          return { kind: 'pending' };
        case 'cancelled':
          return { kind: 'cancelled' };
        default:
          return { kind: 'failed', message: outcome.message };
      }
    },

    signInWithApple: async () => {
      const outcome = await signInThroughApple({
        nonce: () => startAppleNativeAuth(requester()).then((reply) => reply.nonce),
        authorize: (returnTo) =>
          startAppleWebAuth(returnTo, requester()).then((reply) => reply.authorizeUrl),
      });
      switch (outcome.kind) {
        case 'credential':
          try {
            const reply = await finishAppleNativeAuth(
              outcome.nonce, outcome.identityToken, outcome.authorizationCode,
            );
            return await acceptReply(reply, reply.ticket ?? '');
          } catch (caught) {
            return { kind: 'failed', message: failureMessage(caught, 'Apple sign-in did not work.') };
          }
        case 'pending':
          return { kind: 'pending' };
        case 'cancelled':
          return { kind: 'cancelled' };
        default:
          return { kind: 'failed', message: outcome.message };
      }
    },

    // Never throws: a sign-in button waiting on this spins until it settles,
    // and an exception nobody caught would leave it spinning for good.
    redeemSignInTicket: (ticket) => {
      const existing = redemptions.get(ticket);
      if (existing) return existing;
      const redemption = (async (): Promise<SignInOutcome> => {
        try {
          return await acceptReply(await exchangeSignInTicket(ticket), ticket);
        } catch (caught) {
          return { kind: 'failed', message: failureMessage(caught, 'That sign-in did not work.') };
        }
      })();
      redemptions.set(ticket, redemption);
      return redemption;
    },

    claimUsername: async (ticket, username, password = '', reservationToken = '') => {
      const reply = await completeSignup(ticket, username, password, reservationToken);
      if (reply.needsPassword) {
        // Not a failure, so not thrown: the name is an existing account's, and
        // its password finishes the same step. Recorded against the pending
        // signup so the panel can ask, and so a different name typed next clears
        // it again.
        const pending = get().pendingSignup;
        if (pending) setFlow({ pendingSignup: { ...pending, claimingUsername: username } });
        return null;
      }
      if (!reply.token || !reply.account) {
        throw new Error('That sign-in did not complete. Try again.');
      }
      const provider = get().pendingSignup?.provider;
      track('sign_up', { method: provider ?? 'unknown' });
      // A password means an older account, which now signs in with this
      // provider too; no password means a new account made with it.
      const settled = await settle(
        reply.token,
        reply.account,
        password ? 'signedIn' : 'created',
        password && provider ? [provider] : [],
        ticket,
      );
      return settled.account;
    },

    signIn: async (username, password) => {
      const { token, account } = await loginAccount(username, password);
      track('login', { method: 'password' });
      return { kind: 'named', ...(await settle(token, account, 'signedIn', [], '')) };
    },

    signOut: async () => {
      const token = get().sessionToken;
      // Locally first: coming back as this device's anonymous identity is what
      // actually signs the player out, and it must not wait on the server.
      get().clearSession();
      try {
        if (token) await logoutAccount(token);
      } catch {
        // A token the server has already forgotten is still gone from here.
      }
    },

    adoptSession: (token, account) => {
      writeSessionToken(token);
      writeSessionAccountId(account.userId);
      set({ sessionToken: token });
      get().applyAccountUpdate(account);
      return account;
    },

    // For signing out, and for when the server refuses the token: there is
    // nothing left to revoke, and the only state left to be in is anonymous.
    //
    // Anonymous has to mean a guest, though. When the account being left is
    // this device's own — its guest, upgraded in place by signing in — the key
    // this device holds still opens it, so reconnecting with that key would
    // quietly sign straight back in. The device gets a new guest instead, written
    // before the reconnect below goes looking for it. Whose account it was is
    // the lobby's answer when there has been one, and otherwise what was stored
    // with the token, since a session refused at launch is refused before the
    // lobby has said anything.
    clearSession: () => {
      const leaving = get().account?.userId ?? readSessionAccountId();
      if (leaving && leaving === getOrCreateUserId()) {
        set({ profileKey: replaceDeviceIdentity().profileKey });
      }
      writeSessionToken(null);
      writeSessionAccountId(null);
      set({ sessionToken: null });
      setFlow(NO_FLOW);
      get().applyAccountUpdate(null);
    },
  };
};
