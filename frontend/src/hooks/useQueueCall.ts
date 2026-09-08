import { useEffect, useMemo, useState } from 'react';

import { isSignedIn } from '@/store/accountSession';
import { useGameStore } from '@/store/gameStore';
import { canOfferAlerts, usePushStore } from '@/store/push';
import { lobbyGate, queueCallState, type LobbyGate, type QueueCall } from '@/store/queueSelectors';

/**
 * What this player is waiting on, recomputed often enough to look alive.
 *
 * The tick lives here rather than in `queueSelectors` so that module stays pure
 * and testable. One second is the whole vocabulary now: what is left on this
 * card is a wait measured in minutes, and an idle lobby needs no timer at all.
 */
const SEARCH_TICK_MS = 1000;

/**
 * Whether the player is sitting at a real board.
 *
 * Neither browser-local game counts. A bot game and a pass-and-play game are
 * both unrated, both droppable the instant a real opponent turns up, and
 * treating either as a board would make a queued player's lobby read-only for
 * as long as they were practising.
 */
const useAtOwnBoard = () => {
  const gameState = useGameStore((state) => state.gameState);
  const isSpectating = useGameStore((state) => state.isSpectating);
  return Boolean(gameState) && !gameState?.bot && !gameState?.local && !isSpectating;
};

export const useQueueCall = (): QueueCall | null => {
  const queue = useGameStore((state) => state.queue);
  const miss = useGameStore((state) => state.queueMiss);
  const outgoingChallenge = useGameStore((state) => state.outgoingChallenge);
  const connectionStatus = useGameStore((state) => state.connectionStatus);
  const serverUpdate = useGameStore((state) => state.serverUpdate);
  const modes = useGameStore((state) => state.modes);
  const pushEnabled = useGameStore((state) => state.pushEnabled);
  const pushStatus = usePushStore((state) => state.status);
  const snoozedUntil = usePushStore((state) => state.snoozedUntil);
  const atOwnBoard = useAtOwnBoard();

  const active = Boolean(queue.isSearching || outgoingChallenge);
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    if (!active || atOwnBoard) return;
    // Read the clock immediately as well as on the interval. Without this the
    // first frame of a countdown is drawn against whatever `nowMs` the previous,
    // slower tick left behind, so a thirty-second hold can appear as thirty-three.
    setNowMs(Date.now());
    const interval = setInterval(() => setNowMs(Date.now()), SEARCH_TICK_MS);
    return () => clearInterval(interval);
  }, [active, atOwnBoard]);

  return useMemo(
    () =>
      queueCallState({
        queue,
        miss,
        outgoingChallenge,
        connectionStatus,
        modes,
        atOwnBoard,
        pushLive: pushStatus === 'granted',
        canOfferAlerts: canOfferAlerts(pushStatus, snoozedUntil, pushEnabled, nowMs),
        updating: Boolean(serverUpdate?.updating),
        nowMs,
      }),
    [
      atOwnBoard,
      connectionStatus,
      miss,
      modes,
      nowMs,
      outgoingChallenge,
      pushEnabled,
      pushStatus,
      queue,
      serverUpdate,
      snoozedUntil,
    ],
  );
};

/**
 * What the player cannot start right now, and why.
 *
 * Every screen that used to disable half its buttons while `queue.isSearching`
 * reads this instead. Five copies of that expression existed, and all five were
 * fine while a queue lasted twenty seconds and took over the page — and all
 * five would make the app read-only now that it does not.
 */
export const useLobbyGate = (): LobbyGate => {
  const connectionStatus = useGameStore((state) => state.connectionStatus);
  const outgoingChallenge = useGameStore((state) => state.outgoingChallenge);
  const queue = useGameStore((state) => state.queue);
  const sessionToken = useGameStore((state) => state.sessionToken);
  const account = useGameStore((state) => state.account);
  // Held only while a drain is running — the store nulls it the moment the
  // server says the update is off — so its presence is the whole question.
  const serverUpdate = useGameStore((state) => state.serverUpdate);
  const atOwnBoard = useAtOwnBoard();
  const signedIn = isSignedIn(sessionToken, account);

  return useMemo(
    () =>
      lobbyGate({
        connectionStatus,
        atOwnBoard,
        outgoingChallenge,
        queue,
        signedIn,
        updating: Boolean(serverUpdate?.updating),
      }),
    [atOwnBoard, connectionStatus, outgoingChallenge, queue, serverUpdate, signedIn],
  );
};
