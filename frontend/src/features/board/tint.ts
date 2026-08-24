// What a tile is dressed as, and which mode says so.
//
// Infiltration marks the two home boundaries because reaching one wins; Total
// War marks who owns each square because owning most of them wins. The rule
// belongs to the mode rather than to whichever component is drawing it, which
// is why the live board and every diagram of one read it from here.

import { BOARD_SIZE, type ModeID, type PlayerColor, type Tile } from '@/types/game';

const MODE_INFILTRATION = 'V3';
const MODE_TOTAL_WAR = 'V5';

/** A mode's goal rank, or territory somebody owns. */
export interface TileTint {
  color: PlayerColor;
  kind: 'goal' | 'territory';
}

export const tintForTile = (modeId: ModeID | undefined, tile: Tile): TileTint | null => {
  if (modeId === MODE_INFILTRATION) {
    if (tile.y === 0) return { color: 'Red', kind: 'goal' };
    if (tile.y === BOARD_SIZE - 1) return { color: 'Blue', kind: 'goal' };
    return null;
  }

  if (
    modeId === MODE_TOTAL_WAR &&
    (tile.ownerColor === 'Red' || tile.ownerColor === 'Blue')
  ) {
    return { color: tile.ownerColor, kind: 'territory' };
  }

  return null;
};
