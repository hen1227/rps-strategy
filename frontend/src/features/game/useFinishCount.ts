import { useEffect, useState } from 'react';

import { haptic } from '@/haptics/haptics';
import { useReducedMotion } from '@/hooks/useReducedMotion';

import { finishCountPlan, type RatingChange } from './finishCount';

// Games whose card has already counted out in this launch.
//
// The card comes and goes — stepping back through the moves hides it, a
// layout change rebuilds it — and a result counted out once is a result the
// player has seen. Coming back to it shows where the counts ended.
const countedOut = new Set<string>();

export interface FinishCount {
  /** How far the tally has got: pieces revealed, or squares counted. */
  tally: number;
  /** The rating as it reads right now, or null for a game with none. */
  rating: number | null;
}

/**
 * The finished card's counts as they stand at this moment: counting from
 * nothing to the tally and from the old rating to the new, one tap per step,
 * the first time a game's card is shown — and at their final values from the
 * start for a card shown again, or for anybody who has asked for less motion.
 */
export const useFinishCount = (
  gameId: string,
  tallyTotal: number,
  rating: RatingChange | null,
): FinishCount => {
  const reducedMotion = useReducedMotion();
  const before = rating?.before ?? null;
  const after = rating?.after ?? null;
  const starting = (): FinishCount =>
    countedOut.has(gameId) ? { tally: tallyTotal, rating: after } : { tally: 0, rating: before };
  // Kept with the game it belongs to, so a card handed a different game never
  // draws a frame of the last one's numbers while the new count gets going.
  const [shown, setShown] = useState(() => ({ gameId, ...starting() }));

  useEffect(() => {
    if (countedOut.has(gameId) || reducedMotion) {
      countedOut.add(gameId);
      setShown({ gameId, tally: tallyTotal, rating: after });
      return undefined;
    }
    countedOut.add(gameId);
    setShown({ gameId, tally: 0, rating: before });
    const plan = finishCountPlan({
      tally: tallyTotal,
      rating: before === null || after === null ? null : { before, after },
    });
    const timers = [
      ...plan.tally.map((step) =>
        setTimeout(() => {
          setShown((current) => ({ ...current, tally: step.value }));
          haptic('step');
        }, step.atMs),
      ),
      ...plan.rating.map((step) =>
        setTimeout(() => {
          setShown((current) => ({ ...current, rating: step.value }));
          haptic('step');
        }, step.atMs),
      ),
    ];
    // Interrupted part-way, the next look at this card shows the end of it:
    // the game is already marked as counted.
    return () => timers.forEach(clearTimeout);
  }, [after, before, gameId, reducedMotion, tallyTotal]);

  return shown.gameId === gameId ? shown : starting();
};
