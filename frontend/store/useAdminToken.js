import { useCallback, useEffect, useState } from 'react';

import { verifyAdminToken } from './tournamentApi';

// The host-token unlock, in one place.
//
// This pattern — paste a token, verify it against /api/admin/session, keep it
// in localStorage, show the gold panel while it holds — was copied between the
// tournament screen and the opening book screen. A third surface needed it,
// and three copies of an auth check is how one of them ends up subtly
// different, so it lives here now.
//
// `unlocked` means *verified*, never merely "there is something in storage".
// The distinction matters: host controls are gold, destructive, and inline
// among ordinary ones, so showing them on the strength of a string that might
// be stale would offer actions that then fail. A stored token is used to
// attempt verification and nothing else until the server confirms it.

const STORAGE_KEY = 'rpsAdminToken';

const readStored = () => {
  try {
    return globalThis.localStorage?.getItem(STORAGE_KEY)?.trim() ?? '';
  } catch {
    return '';
  }
};

const writeStored = (token) => {
  try {
    if (token) globalThis.localStorage?.setItem(STORAGE_KEY, token);
    else globalThis.localStorage?.removeItem(STORAGE_KEY);
  } catch {
    // Restricted storage: the token lives for this page view only.
  }
};

export function useAdminToken() {
  const [token, setToken] = useState(readStored);
  const [verified, setVerified] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [error, setError] = useState(null);

  // Only ever runs for someone who has pasted a token before, so this is not a
  // request on every player's page load.
  useEffect(() => {
    if (!token || verified) return undefined;
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
  }, [token, verified]);

  const unlock = useCallback(async (draft) => {
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
      setError(caught.message ?? 'That token was not accepted.');
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

  return { token, unlocked: verified && Boolean(token), unlock, lock, verifying, error };
}
