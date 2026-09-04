import { usePathname, useRouter } from 'expo-router';
import { useCallback } from 'react';

import { links } from '@/navigation/links';

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
 * Arriving at a game is a step forward. Changing which board you are watching —
 * from the rail over a series, or from a tournament's other boards — is not: it
 * replaces, so the back button returns to wherever you came in from rather than
 * walking back through every board you looked at.
 */
export const useWatchGame = () => {
  const router = useRouter();
  const pathname = usePathname();

  return useCallback(
    (gameId: string) => {
      if (!gameId) return;
      if (pathname === '/watch') {
        router.replace(links.watch(gameId));
        return;
      }
      router.push(links.watch(gameId));
    },
    [pathname, router],
  );
};

export default useWatchGame;
