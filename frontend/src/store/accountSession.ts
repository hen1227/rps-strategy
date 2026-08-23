import { loginAccount, logoutAccount, registerAccount } from './api/bots';
import { getOrCreateUserId } from './localIdentity';
import type { GameStore } from './types';
import type { Account } from '@/types/protocol';
import type { StateCreator } from 'zustand';

// The signed-in session: one token, in one place.
//
// It lives in the store rather than in the screen that collects the password
// because two other things need it. The WebSocket authenticates with it, so a
// signed-in player is themselves on any browser they open; and the bot panel
// cannot list anything without it.
//
// Everything here goes through `applyAccountUpdate`, which reconnects the
// socket. Signing in that does not change who you are in the lobby would be
// the confusing half-measure.

const SESSION_TOKEN_KEY = 'rps.sessionToken.v1';

const readSessionToken = (): string | null => {
  try {
    return globalThis.localStorage?.getItem(SESSION_TOKEN_KEY) ?? null;
  } catch {
    return null;
  }
};

const writeSessionToken = (token: string | null) => {
  try {
    if (token) globalThis.localStorage?.setItem(SESSION_TOKEN_KEY, token);
    else globalThis.localStorage?.removeItem(SESSION_TOKEN_KEY);
  } catch {
    // Private browsing: the session lasts as long as the tab does.
  }
};

export interface SessionSlice {
  sessionToken: string | null;
  register: (username: string, password: string, reservationToken?: string) => Promise<Account>;
  signIn: (username: string, password: string) => Promise<Account>;
  signOut: () => Promise<void>;
  adoptSession: (token: string, account: Account) => Account;
  clearSession: () => void;
}

export const createSessionSlice: StateCreator<GameStore, [], [], SessionSlice> = (set, get) => ({
  sessionToken: readSessionToken(),

  // Registering upgrades this browser's anonymous account in place, keeping
  // its rating, its record, and its games. The local key goes with the request
  // because that is what proves the history being claimed is the caller's own.
  register: (username, password, reservationToken = '') =>
    registerAccount(
      get().profileKey,
      getOrCreateUserId(),
      username,
      password,
      reservationToken,
    ).then(({ token, account }) => get().adoptSession(token, account)),

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
    set({ sessionToken: null });
    get().applyAccountUpdate(null);
  },
});
