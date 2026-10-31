import { useCallback, useEffect, useRef } from 'react';

import { LOW_TIME_MS } from '@/store/clockSelectors';
import { useGameStore } from '@/store/gameStore';
import { FIRST_MOVE_CRITICAL_MS } from '@/store/queueSelectors';
import type { ActiveGame } from '@/store/types';

import { buzz, haptic } from './haptics';
import { gameHapticForTransition, offerArrived } from './hapticForTransition';
import {
  IDLE_WATCH,
  clockReading,
  firstMoveReading,
  watchCountdown,
  type CountdownReading,
} from './lowClock';

// What a game feels like while it is being played: the other side's moves, the
// result, an offer arriving, and the two countdowns worth a buzz.
//
// Mounted once, at the root beside the sound effects and for the same reason:
// a game is felt wherever the player happens to be looking, and a rebuild of
// the routed tree must not make it forget the state it last saw and tap the
// whole game again. Your own touches are felt where they happen, on the board;
// everything here arrives from somewhere else.

/**
 * Watch one countdown and buzz as it goes under its line.
 *
 * No polling. Each look says when the line will be crossed if nothing changes,
 * and the next look is booked for that moment; any new snapshot cancels the
 * booking and looks again, since an extension or a move has moved the line.
 */
const useCountdownBuzz = (read: (nowMs: number) => CountdownReading | null, lineMs: number) => {
  const watch = useRef(IDLE_WATCH);
  useEffect(() => {
    let booked: ReturnType<typeof setTimeout> | undefined;
    const look = () => {
      const step = watchCountdown(watch.current, read(Date.now()), lineMs);
      watch.current = step.watch;
      if (step.buzz) buzz('lowClock');
      // A few milliseconds past the line, so the look finds it crossed.
      if (step.checkInMs !== null) booked = setTimeout(look, step.checkInMs + 5);
    };
    look();
    return () => clearTimeout(booked);
  }, [lineMs, read]);
};

export default function GameHaptics() {
  const gameState = useGameStore((state) => state.gameState);
  const playerColor = useGameStore((state) => state.playerColor);
  const rejectedMoveCount = useGameStore((state) => state.rejectedMoveCount);
  const firstMoveDeadline = useGameStore((state) => state.firstMoveDeadline);

  const previousGame = useRef<ActiveGame | null>(null);
  useEffect(() => {
    const previous = previousGame.current;
    previousGame.current = gameState;
    if (offerArrived(previous, gameState, playerColor)) haptic('notice');
    const feel = gameHapticForTransition(previous, gameState, playerColor);
    if (!feel) return;
    if (feel.kind === 'buzz') {
      buzz(feel.moment);
      return;
    }
    if (!feel.delayMs) {
      haptic(feel.event);
      return;
    }
    // Deliberately not cancelled by the next snapshot: whatever follows an
    // ending — the rating, a spectator leaving — changes nothing about it.
    setTimeout(() => haptic(feel.event), feel.delayMs);
  }, [gameState, playerColor]);

  // A refused move changes no game state at all, so the store counts them and
  // the count going up is the event, as it is for the illegal-move sound. Only
  // refusals after this mounted: a count already standing is old news.
  const heardRejections = useRef(rejectedMoveCount);
  useEffect(() => {
    const isNew = rejectedMoveCount > heardRejections.current;
    heardRejections.current = rejectedMoveCount;
    if (isNew) haptic('refused');
  }, [rejectedMoveCount]);

  const readClock = useCallback(
    (nowMs: number) => clockReading(gameState, playerColor, nowMs),
    [gameState, playerColor],
  );
  useCountdownBuzz(readClock, LOW_TIME_MS);

  const readFirstMove = useCallback(
    (nowMs: number) => firstMoveReading(gameState, playerColor, firstMoveDeadline, nowMs),
    [firstMoveDeadline, gameState, playerColor],
  );
  useCountdownBuzz(readFirstMove, FIRST_MOVE_CRITICAL_MS);

  return null;
}
