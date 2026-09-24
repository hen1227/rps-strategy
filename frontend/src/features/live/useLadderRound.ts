import { useCallback, useEffect, useState } from 'react';

import { ladderRoundView, type LadderRoundView } from './ladderRound';
import { useNow } from '@/hooks/useNow';
import { fetchLadderPool, type LadderPool } from '@/store/api/ladderPool';
import { useGameStore } from '@/store/gameStore';

/**
 * How often the schedule is re-read.
 *
 * The schedule itself barely moves — it is derived from the hour, so the client
 * could compute it — but two things on the same payload do: which round was last
 * seated, and whether a yardstick has been designated. Two minutes is often
 * enough that the block notices the top of the hour without being a request a
 * minute from every open tab for a payload of six rows.
 */
const REFRESH_MS = 120_000;

/** A second, because this drives a countdown clock. */
const TICK_MS = 1_000;

/**
 * The next ranked round, ticking.
 *
 * Its own hook rather than part of `useLiveSnapshot`, because the two have
 * different sources and different failure modes: the snapshot is derived from
 * socket state that is always there, and this needs a fetch that can fail
 * against a server too old to serve the route. When it does, the hook returns
 * null and the rail simply has one fewer block — a live page missing its
 * countdown is a smaller problem than a live page showing an error where the
 * boards should be.
 *
 * Null also before the browser has a clock, which is `useNow`'s contract and not
 * a case to paper over: these pages are pre-rendered in Node, and a countdown
 * computed during that render would bake a stale minute into the HTML for React
 * to throw the whole page away over. So the block is absent from the static page
 * and appears a render later, which is what it should do.
 */
export const useLadderRound = (): LadderRoundView | null => {
  const modes = useGameStore((state) => state.modes);
  const pool = useLadderPool();
  const now = useNow(TICK_MS);

  if (now === null) return null;
  return ladderRoundView(pool, modes, now);
};

/**
 * The published schedule on its own, without the countdown.
 *
 * Split out because two callers want different halves of it: the rail wants the
 * next round and ticks every second for it, and the ladder page wants only
 * `anchorBotId` — whether a reference engine is standing, and therefore whether
 * `1` on that board means chance or means the weakest engine on it. Giving the
 * page the ticking hook would re-render a list of fifty rows once a second to
 * read a field that changes about once a year.
 */
export const useLadderPool = (): LadderPool | null => {
  const [pool, setPool] = useState<LadderPool | null>(null);

  const load = useCallback(async (alive: () => boolean) => {
    try {
      const next = await fetchLadderPool();
      if (alive()) setPool(next);
    } catch {
      // Left as it was rather than cleared. A refresh that failed is a request
      // that did not arrive, not news that the round was cancelled, and blanking
      // a running countdown over one dropped fetch would be the visible bug.
    }
  }, []);

  useEffect(() => {
    let mounted = true;
    const alive = () => mounted;
    void load(alive);
    const timer = setInterval(() => void load(alive), REFRESH_MS);
    return () => {
      mounted = false;
      clearInterval(timer);
    };
  }, [load]);

  return pool;
};
