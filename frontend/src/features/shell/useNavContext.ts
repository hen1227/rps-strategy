import type { NavContext } from './sections';
import { useNow } from '@/hooks/useNow';
import { useGameStore } from '@/store/gameStore';

/**
 * The two things a section's visibility rule is answered against.
 *
 * One hook rather than each surface assembling its own, so the sidebar, the tab
 * bar and the strip cannot end up disagreeing about which rows exist — which is
 * the whole reason the list is in one file. See `NavContext` for why the clock
 * is in here and why it starts as null.
 */
export const useNavContext = (): NavContext => {
  const account = useGameStore((state) => state.account);
  // A minute is far finer than this needs — the only boundary it decides is the
  // end of an event — but it is what everything else on this site reads the
  // clock at, and a second timer on a different period is a thing to explain.
  const now = useNow();
  return { account, now };
};
