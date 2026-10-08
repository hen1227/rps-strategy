import {
  completeSignup,
  exchangeSignInTicket,
  finishAppleNativeAuth,
  loginAccount,
  logoutAccount,
  startAppleNativeAuth,
  startAppleWebAuth,
  startDiscordAuth,
  type SignInProvider,
  type SignInReply,
} from './api/bots';
import { isAppleSignInAvailable, signInThroughApple } from './appleAuth';
import { isDiscordSignInAvailable, signInThroughDiscord } from './discordAuth';
import { type DiscordOutcome } from './discordAuth.types';
import { deviceStorage } from './deviceStorage';
import { getOrCreateUserId, replaceDeviceIdentity } from './localIdentity';
import type { GameStore } from './types';
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

/**
 * What a sign-in produced once the provider had answered.
 *
 * `named` means there is a session and nothing else to do. `unnamed` means the
 * player is new and still has to agree a username; the ticket stays live for
 * that second step. `pending` is a web redirect having been issued, and
 * nothing after it runs.
 */
export type SignInOutcome =
  | { kind: 'named'; account: Account }
  | ({ kind: 'unnamed' } & PendingSignup)
  | { kind: 'pending' }
  | { kind: 'cancelled' }
  | { kind: 'failed'; message: string };

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
  dismissSignup: () => void;
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
  signIn: (username: string, password: string) => Promise<Account>;
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

  // The one reading of a finished sign-in, whichever provider it came from.
  const acceptReply = (reply: SignInReply, ticket: string): SignInOutcome => {
    if (reply.needsUsername) {
      const pending: PendingSignup = {
        ticket: reply.ticket || ticket,
        provider: reply.provider ?? 'discord',
        suggestedUsername: reply.suggestedUsername ?? '',
        discordHandle: reply.discordHandle ?? '',
      };
      set({ pendingSignup: pending });
      return { kind: 'unnamed', ...pending };
    }
    if (!reply.token || !reply.account) {
      return { kind: 'failed', message: 'That sign-in did not complete. Try again.' };
    }
    return { kind: 'named', account: get().adoptSession(reply.token, reply.account) };
  };

  return {
    sessionToken: readSessionToken(),

    discordSignInAvailable: isDiscordSignInAvailable(),
    appleSignInAvailable: isAppleSignInAvailable(),
    pendingSignup: null,

    // Dropping the ticket is the only way out of the naming step, and it costs
    // the player nothing but another trip through the provider: no account was
    // created and no name was held.
    dismissSignup: () => set({ pendingSignup: null }),

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
            return acceptReply(reply, reply.ticket ?? '');
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
    redeemSignInTicket: async (ticket) => {
      try {
        return acceptReply(await exchangeSignInTicket(ticket), ticket);
      } catch (caught) {
        return { kind: 'failed', message: failureMessage(caught, 'That sign-in did not work.') };
      }
    },

    claimUsername: async (ticket, username, password = '', reservationToken = '') => {
      const reply = await completeSignup(ticket, username, password, reservationToken);
      if (reply.needsPassword) {
        // Not a failure, so not thrown: the name is an existing account's, and
        // its password finishes the same step. Recorded against the pending
        // signup so the panel can ask, and so a different name typed next clears
        // it again.
        const pending = get().pendingSignup;
        if (pending) set({ pendingSignup: { ...pending, claimingUsername: username } });
        return null;
      }
      if (!reply.token || !reply.account) {
        throw new Error('That sign-in did not complete. Try again.');
      }
      set({ pendingSignup: null });
      return get().adoptSession(reply.token, reply.account);
    },

    signIn: (username, password) =>
      loginAccount(username, password).then(({ token, account }) =>
        get().adoptSession(token, account),
      ),

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
      set({ sessionToken: null, pendingSignup: null });
      get().applyAccountUpdate(null);
    },
  };
};
