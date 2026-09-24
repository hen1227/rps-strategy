import {
  completeDiscordSignup,
  exchangeDiscordTicket,
  loginAccount,
  logoutAccount,
  startDiscordAuth,
} from './api/bots';
import {
  isDiscordSignInAvailable,
  signInThroughDiscord,
} from './discordAuth';
import { type DiscordOutcome } from './discordAuth.types';
import { deviceStorage } from './deviceStorage';
import { getOrCreateUserId } from './localIdentity';
import type { GameStore } from './types';
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

/**
 * What a Discord sign-in produced once the ticket has been redeemed.
 *
 * `named` means there is a session and nothing else to do. `unnamed` means the
 * player is new and still has to agree a username; the ticket stays live for
 * that second step. `pending` is the web redirect having been issued, and
 * nothing after it runs.
 */
export type DiscordSignIn =
  | { kind: 'named'; account: Account }
  | { kind: 'unnamed'; ticket: string; suggestedUsername: string; discordHandle: string }
  | { kind: 'pending' }
  | { kind: 'cancelled' }
  | { kind: 'failed'; message: string };

/** A signup that has proved who it is and still needs a name. */
export interface PendingDiscordSignup {
  ticket: string;
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
   * Set when Discord has vouched for somebody who has no account here yet.
   *
   * In the store rather than passed between screens because the two platforms
   * arrive at it from different directions: the web build redeems its ticket on
   * the callback page and then navigates, while the native build redeems in
   * place when the sheet closes. Parking it here means one panel handles both.
   */
  pendingDiscordSignup: PendingDiscordSignup | null;
  dismissDiscordSignup: () => void;
  /** Whether this build can offer Discord at all. See `discordAuth.types`. */
  discordSignInAvailable: boolean;
  signInWithDiscord: () => Promise<DiscordSignIn>;
  /** Redeem a ticket the browser came back with. The web half's second step. */
  redeemDiscordTicket: (ticket: string) => Promise<DiscordSignIn>;
  /**
   * Finish the naming step.
   *
   * Resolves to the account when it is done. Resolves to null when the server
   * has asked for a password instead — the name given is an older account's,
   * and `pendingDiscordSignup.claimingUsername` now says which. The ticket is
   * still live either way, so nothing is lost by answering.
   */
  claimDiscordUsername: (
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

export const createSessionSlice: StateCreator<GameStore, [], [], SessionSlice> = (set, get) => ({
  sessionToken: readSessionToken(),

  discordSignInAvailable: isDiscordSignInAvailable(),
  pendingDiscordSignup: null,

  // Dropping the ticket is the only way out of the naming step, and it costs
  // the player nothing but another trip through Discord: no account was created
  // and no name was held.
  dismissDiscordSignup: () => set({ pendingDiscordSignup: null }),

  // Signing in with Discord upgrades this browser's anonymous account in place
  // where it can, keeping the rating, the record and the games. The local key
  // goes with the request because that is what proves the history being claimed
  // belongs to the caller — the same proof registering used to need.
  //
  // A session token is sent instead when there is one, which is how an account
  // that still has a password links Discord to itself rather than starting again.
  signInWithDiscord: async () => {
    const outcome: DiscordOutcome = await signInThroughDiscord((redirectUri) =>
      startDiscordAuth(redirectUri, {
        userId: getOrCreateUserId(),
        credential: get().sessionToken ?? get().profileKey,
      }).then((reply) => reply.authorizeUrl),
    );
    switch (outcome.kind) {
      case 'ticket':
        return get().redeemDiscordTicket(outcome.ticket);
      case 'pending':
        // The browser is navigating away, so nothing after this runs.
        return { kind: 'pending' };
      case 'cancelled':
        return { kind: 'cancelled' };
      default:
        return { kind: 'failed', message: outcome.message };
    }
  },

  redeemDiscordTicket: async (ticket) => {
    const reply = await exchangeDiscordTicket(ticket);
    if (reply.needsUsername) {
      const pending: PendingDiscordSignup = {
        ticket,
        suggestedUsername: reply.suggestedUsername ?? '',
        discordHandle: reply.discordHandle ?? '',
      };
      set({ pendingDiscordSignup: pending });
      return { kind: 'unnamed', ...pending };
    }
    if (!reply.token || !reply.account) {
      return { kind: 'failed', message: 'That sign-in did not complete. Try again.' };
    }
    return { kind: 'named', account: get().adoptSession(reply.token, reply.account) };
  },

  claimDiscordUsername: async (ticket, username, password = '', reservationToken = '') => {
    const reply = await completeDiscordSignup(ticket, username, password, reservationToken);
    if (reply.needsPassword) {
      // Not a failure, so not thrown: the name is an existing account's, and
      // its password finishes the same step. Recorded against the pending
      // signup so the panel can ask, and so a different name typed next clears
      // it again.
      const pending = get().pendingDiscordSignup;
      if (pending) set({ pendingDiscordSignup: { ...pending, claimingUsername: username } });
      return null;
    }
    if (!reply.token || !reply.account) {
      throw new Error('That sign-in did not complete. Try again.');
    }
    set({ pendingDiscordSignup: null });
    return get().adoptSession(reply.token, reply.account);
  },

  signIn: (username, password) =>
    loginAccount(username, password).then(({ token, account }) =>
      get().adoptSession(token, account),
    ),

  signOut: async () => {
    const token = get().sessionToken;
    // Locally first: coming back as this browser's anonymous identity is what
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
    set({ sessionToken: token });
    get().applyAccountUpdate(account);
    return account;
  },

  // For when the server refuses the token: there is nothing left to revoke,
  // and the only state left to be in is anonymous.
  clearSession: () => {
    writeSessionToken(null);
    set({ sessionToken: null, pendingDiscordSignup: null });
    get().applyAccountUpdate(null);
  },
});
