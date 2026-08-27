import { liveSnapshot, type LiveSnapshot } from './liveSelectors';
import { useGameStore } from '@/store/gameStore';

/**
 * The whole live picture, read from the store in one place.
 *
 * Its own file rather than the rail's, because the rail is no longer the only
 * thing that draws it: a phone has no room for a column beside the page, so the
 * lobby shows the live boards itself. One hook, so the two cannot drift.
 */
export const useLiveSnapshot = (): LiveSnapshot => {
  const accountId = useGameStore((state) => state.accountId);
  const onlineCount = useGameStore((state) => state.onlineCount);
  const liveGames = useGameStore((state) => state.liveGames);
  const botPlayerCount = useGameStore((state) => state.botPlayerCount);
  const engineBots = useGameStore((state) => state.engineBots);
  const openChallenges = useGameStore((state) => state.openChallenges);
  const tournaments = useGameStore((state) => state.tournaments);
  const modes = useGameStore((state) => state.modes);
  return liveSnapshot({
    accountId,
    onlineCount,
    liveGames,
    botPlayerCount,
    engineBots,
    openChallenges,
    tournaments,
    modes,
  });
};
