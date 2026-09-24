import { useCallback } from 'react';

import { links } from '@/navigation/links';
import { useGoTo } from '@/navigation/stack';

/**
 * Go and watch a live game.
 *
 * Every list that offers a game to watch calls this, and nothing outside the
 * watch screen calls `spectateGame` any more. Asking the server is that
 * screen's job, because the address has to be right first — a list that
 * spectated directly was relying on the app-level redirect noticing a board had
 * appeared in the store and dragging the browser to `/play`, which is exactly
 * how watching ended up with no address of its own.
 *
 * How that lands on the stack is `useGoTo`'s decision rather than this hook's.
 * It used to be written here: arriving from a list was a step forward and
 * changing boards was a `replace`, so that going back left by the door you came
 * in rather than walking back through every board you had looked at. Both of
 * those still happen, and the second is still a `replace` for a reason more
 * particular than tidiness — see the note on `stackMove`. What that rule adds is
 * the case this could not see, because it is about the page being *left* rather
 * than the game being opened: a watched game reached from a review, from a
 * board, or from any other full-screen page now takes that page's place instead
 * of covering it over.
 */
export const useWatchGame = () => {
  const go = useGoTo();

  return useCallback(
    (gameId: string) => {
      if (!gameId) return;
      go(links.watch(gameId));
    },
    [go],
  );
};

export default useWatchGame;
