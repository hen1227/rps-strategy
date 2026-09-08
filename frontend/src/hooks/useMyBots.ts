import { useCallback, useEffect, useState } from 'react';

import { listMyBots, type OwnedBot } from '@/store/api/bots';
import { useGameStore } from '@/store/gameStore';

// The signed-in account's own engines, for the screens that are not the bot
// manager.
//
// The manager owns the *editing* of this list and keeps its own state for it,
// because it changes what it is showing. What this hook is for is the other
// direction: a screen that needs to know which engines an account has, and
// which accounts they play under, in order to answer a question about
// something else. Registering for a tournament is the case that produced it —
// the entrant picker offers them, and "am I already in this event" is a
// question about their account ids rather than the owner's.
//
// Shared and cached per token, because two of those screens can be mounted at
// once — the home spotlight and the tournament board — and one list is one
// request.

interface Cached {
  token: string;
  bots: OwnedBot[];
}

let cached: Cached | null = null;
let inFlight: Promise<OwnedBot[]> | null = null;

const load = (token: string): Promise<OwnedBot[]> => {
  if (cached?.token === token) return Promise.resolve(cached.bots);
  inFlight ??= listMyBots(token)
    .then((owned) => {
      cached = { token, bots: owned.bots ?? [] };
      return cached.bots;
    })
    // An account with no bots and an unreachable server look the same here on
    // purpose. Neither is worth a banner on a page about something else, and
    // the register button is refused by the server either way.
    .catch(() => [] as OwnedBot[])
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
};

export interface MyBots {
  /** Every bot this account owns, unclaimed slots included. */
  bots: OwnedBot[];
  /**
   * The accounts those engines play under, which is what appears in a field.
   * Unclaimed slots have none and are absent from this.
   */
  userIds: string[];
  loading: boolean;
  /** Drop the cache and read the list again. */
  reload: () => void;
}

const NONE: OwnedBot[] = [];

export function useMyBots(): MyBots {
  const sessionToken = useGameStore((state) => state.sessionToken);
  const [bots, setBots] = useState<OwnedBot[]>(
    cached?.token === sessionToken ? cached.bots : NONE,
  );
  const [loading, setLoading] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!sessionToken) {
      setBots(NONE);
      return;
    }
    let cancelled = false;
    setLoading(true);
    load(sessionToken)
      .then((next) => {
        if (!cancelled) setBots(next);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionToken, attempt]);

  const reload = useCallback(() => {
    cached = null;
    setAttempt((count) => count + 1);
  }, []);

  return {
    bots,
    userIds: bots.map((bot) => bot.userId ?? '').filter(Boolean),
    loading,
    reload,
  };
}
