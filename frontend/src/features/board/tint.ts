// What a tile is dressed as, and which mode says so.
//
// A mode won by arriving marks the tiles that win, because reaching one ends
// the game; Total War marks who owns each square, because owning most of them
// wins. The rule belongs to the mode rather than to whichever component is
// drawing it, which is why the live board and every diagram of one read it
// from here.
//
// The goal tiles themselves come from `@/engine/goals`, shared with the rules
// that end the game on them.

import { goalOwnerAt, type BoardShape, type RulesEra } from '@/engine/goals';
import type { ModeID, PlayerColor, Tile } from '@/types/game';

const MODE_TOTAL_WAR = 'V5';

/** A tile somebody wins by standing on, or territory somebody owns. */
export interface TileTint {
  color: PlayerColor;
  kind: 'goal' | 'territory';
}

/**
 * `shape` is the board's own size, not a constant: Blue's goal is measured from
 * the far edge of whatever board this is, and a mode may be any rectangle.
 *
 * `era` is which rules decide where the goals are, and it is here rather than
 * assumed because a review of a pre-change record is drawn on this board. A
 * board that tinted today's corners under a game being replayed on yesterday's
 * would point at the wrong square all the way through and then end the game on
 * a tile it never marked.
 */
export const tintForTile = (
  modeId: ModeID | undefined,
  tile: Tile,
  shape: BoardShape,
  era: RulesEra = 'current',
): TileTint | null => {
  const goal = goalOwnerAt(modeId, tile.x, tile.y, shape, era);
  if (goal) return { color: goal, kind: 'goal' };

  if (
    modeId === MODE_TOTAL_WAR &&
    (tile.ownerColor === 'Red' || tile.ownerColor === 'Blue')
  ) {
    return { color: tile.ownerColor, kind: 'territory' };
  }

  return null;
};
