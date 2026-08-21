import { useMemo } from 'react';

import { useGameStore } from './gameStore';
import { tournamentCallToAction } from './tournamentSelectors';

/**
 * The tournament match this player still has to answer, or null when there is
 * nothing to answer or they are already sitting at their own board. Both the
 * floating call to action and the screens that make room for it read this, so
 * the rule lives in one place.
 */
export const useTournamentCall = () => {
  const accountId = useGameStore((state) => state.accountId);
  const tournaments = useGameStore((state) => state.tournaments);
  const gameState = useGameStore((state) => state.gameState);
  const isSpectating = useGameStore((state) => state.isSpectating);

  const call = useMemo(
    () => tournamentCallToAction(tournaments, accountId),
    [tournaments, accountId],
  );

  const isPlayingOwnGame = Boolean(gameState) && !isSpectating;
  return isPlayingOwnGame ? null : call;
};
