import { useCallback, useEffect, useState } from 'react';

import { verifyAdminToken } from '@/store/api/tournaments';
import { useGameStore } from '@/store/gameStore';

// The host-token unlock, in one place.
//
// This pattern — paste a token, verify it against /api/admin/session, keep it
// in localStorage, show the gold panel while it holds — was copied between the
// tournament screen and the opening book screen. A third surface needed it,
// and three copies of an auth check is how one of them ends up subtly
// different, so it lives here now.
//
// There are two doors. A signed-in administrator is one already — the server
// accepts their session token on every admin route, and `account.isAdmin` says
// so before any request is made — so they never see the token form at all. The
// shared host token is the other door, for a host with no account, and it is
// the one this hook was originally only about.
//
// `unlocked` means *verified*, never merely "there is something in storage".
// The distinction matters: host controls are gold, destructive, and inline
// among ordinary ones, so showing them on the strength of a string that might
// be stale would offer actions that then fail. A stored token is used to
// attempt verification and nothing else until the server confirms it.

const STORAGE_KEY = 'rpsAdminToken';

const readStored = (): string => {
  try {
    return globalThis.localStorage?.getItem(STORAGE_KEY)?.trim() ?? '';
  } catch {
    return '';
  }
};

const writeStored = (token: string) => {
  try {
    if (token) globalThis.localStorage?.setItem(STORAGE_KEY, token);
    else globalThis.localStorage?.removeItem(STORAGE_KEY);
  } catch {
    // Restricted storage: the token lives for this page view only.
  }
};

/** The admin credential, as a screen sees it. */
export interface AdminToken {
  /** Whatever should go in `Authorization`, whichever door was used. */
  token: string;
  /** Verified by the server, not merely present in storage. */
  unlocked: boolean;
  /**
   * True when the credential is this player's own session because their account
   * carries the admin flag. Screens use it to hide the token form and the Lock
   * button, neither of which means anything to somebody who simply is one.
   */
  bySession: boolean;
  unlock: (draft: string) => Promise<boolean>;
  lock: () => void;
  verifying: boolean;
  error: string | null;
}

export function useAdminToken(): AdminToken {
  const sessionToken = useGameStore((state) => state.sessionToken);
  const isAccountAdmin = useGameStore((state) => Boolean(state.account?.isAdmin));
  const bySession = isAccountAdmin && Boolean(sessionToken);
  const [token, setToken] = useState(readStored);
  const [verified, setVerified] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Only ever runs for someone who has pasted a token before, so this is not a
  // request on every player's page load — and never for an administrator, whose
  // session already answers the question.
  useEffect(() => {
    if (bySession || !token || verified) return undefined;
    let cancelled = false;
    setVerifying(true);
    (async () => {
      try {
        await verifyAdminToken(token);
        if (!cancelled) setVerified(true);
      } catch {
        // A token that no longer works is worse than none: it would offer
        // controls that fail. Drop it quietly.
        if (cancelled) return;
        writeStored('');
        setToken('');
      } finally {
        if (!cancelled) setVerifying(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [bySession, token, verified]);

  const unlock = useCallback(async (draft: string) => {
    const candidate = String(draft ?? '').trim();
    if (!candidate) return false;
    setVerifying(true);
    setError(null);
    try {
      await verifyAdminToken(candidate);
      writeStored(candidate);
      setToken(candidate);
      setVerified(true);
      return true;
    } catch (caught) {
      setError((caught as Error | null)?.message ?? 'That token was not accepted.');
      return false;
    } finally {
      setVerifying(false);
    }
  }, []);

  const lock = useCallback(() => {
    writeStored('');
    setToken('');
    setVerified(false);
    setError(null);
  }, []);

  if (bySession) {
    return {
      token: sessionToken ?? '',
      unlocked: true,
      bySession: true,
      unlock,
      lock,
      verifying: false,
      error: null,
    };
  }
  return {
    token,
    unlocked: verified && Boolean(token),
    bySession: false,
    unlock,
    lock,
    verifying,
    error,
  };
}
