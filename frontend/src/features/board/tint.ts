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

import { goalOwnerAt, type BoardShape } from '@/engine/goals';
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
 */
export const tintForTile = (
  modeId: ModeID | undefined,
  tile: Tile,
  shape: BoardShape,
): TileTint | null => {
  const goal = goalOwnerAt(modeId, tile.x, tile.y, shape);
  if (goal) return { color: goal, kind: 'goal' };

  if (
    modeId === MODE_TOTAL_WAR &&
    (tile.ownerColor === 'Red' || tile.ownerColor === 'Blue')
  ) {
    return { color: tile.ownerColor, kind: 'territory' };
  }

  return null;
};
