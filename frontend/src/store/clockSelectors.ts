// What the clocks did between two snapshots.
//
// A game state is a photograph: it says what the clocks read, never what just
// happened to them. Everything a screen wants to *react* to — a bonus landing,
// an offer being answered — has to be read out of the difference between the
// photograph on screen and the one that replaced it, which is what this file
// does.

import type { ActiveGame } from './types';

/** A three-minute bonus, the moment it landed on both clocks. */
export interface TimeExtension {
  /** The local instant it arrived. Changing it is what replays the flourish. */
  at: number;
  /** What was actually granted, read off the clocks rather than assumed. */
  bonusMs: number;
}

/**
 * The extension these two snapshots show being granted, in milliseconds.
 *
 * Both players and every spectator get the same pair of snapshots, so all of
 * them see the bonus land without the server having to announce it separately.
 *
 * The reasoning, in order: a move is the only other thing that adds to a clock
 * (the increment), so a snapshot at the same move number rules it out. A
 * request that was pending and is now gone was answered one way or the other.
 * And declining leaves both clocks to run down — so at that point a clock that
 * went *up* is the bonus and can be nothing else.
 *
 * The side that was thinking has the elapsed time subtracted from its bonus
 * before we ever see it, and on a long think that can swallow the lot. The
 * other side's gain is the whole bonus untouched, which is why the larger of
 * the two is the number that gets shown.
 */
export const grantedTimeExtension = (
  previousGame: ActiveGame | null | undefined,
  nextGame: ActiveGame | null | undefined,
): number | null => {
  const previous = previousGame?.clock;
  const next = nextGame?.clock;
  if (!previous || !next || previousGame.gameId !== nextGame.gameId) return null;
  if (previousGame.moveNumber !== nextGame.moveNumber) return null;
  if (!previousGame.timeOfferedBy || nextGame.timeOfferedBy) return null;
  const bonusMs = Math.max(
    next.redRemainingMs - previous.redRemainingMs,
    next.blueRemainingMs - previous.blueRemainingMs,
  );
  return bonusMs > 0 ? bonusMs : null;
};
