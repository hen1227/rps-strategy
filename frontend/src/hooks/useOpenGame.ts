import { useRouter } from 'expo-router';
import { useCallback } from 'react';

import { links } from '@/navigation/links';
import { useGameStore } from '@/store/gameStore';
import { isGameLive } from '@/store/spectateSelectors';

/**
 * Open a game, wherever it currently is.
 *
 * A game id means two different pages depending on when you press it: a game
 * still being played has no archived record, so its review lands on "this game
 * cannot be reviewed" — it is watched instead — and a finished one has no board
 * left, so it is read back. Which of those a series column is, is not knowable
 * from the run: only the lobby's live list can say.
 *
 * That rule was written on the review screen and again in the spectate rail, and
 * the history feed had neither — it sent every column of every run to a review,
 * so pressing the game two engines were playing at that moment opened an error.
 * This is the rule itself, for any list that hands somebody a game.
 *
 * Screens that also have their own state to unwind — the review screen dropping
 * the PGN it is holding, the spectate screen handing its board over — keep their
 * own version and share `isGameLive` instead. The decision is the same one; what
 * differs is what else has to happen around it.
 */
export const useOpenGame = () => {
  const router = useRouter();
  const liveGames = useGameStore((state) => state.liveGames);
  const spectateGame = useGameStore((state) => state.spectateGame);

  return useCallback(
    (gameId: string) => {
      if (!gameId) return;
      if (isGameLive(liveGames, gameId)) {
        spectateGame(gameId);
        router.push(links.play());
        return;
      }
      router.push(links.review(gameId));
    },
    [liveGames, router, spectateGame],
  );
};
