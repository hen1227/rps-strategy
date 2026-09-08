// Where a mode is won by arriving, and whose arrival wins there.
//
// Two modes are decided by a piece *standing somewhere* rather than by what is
// left on the board. Infiltration's goal is the opponent's whole home rank;
// Intransitive's is the single corner their army opened in. Both are the same
// question asked of one tile — does standing here win, and for whom — and it is
// asked from three places: the board tints the tiles, `applyAnalysisMove`
// decides the game on them, and the how-to-play card draws them. One answer
// here, because a tile the board tints as a goal and a tile the rules end the
// game on must be the same tile.
//
// Mirrors the backend, which holds the same rule twice for the same reason:
// `mode_infiltration.go` compares against the goal rank and
// `mode_intransitive.go` against `GoalCorner`.

import type { GameEndReason, ModeID, SideColor } from '@/types/game';

const MODE_INFILTRATION = 'V3';
const MODE_INTRANSITIVE = 'V6';

/** The board a goal is measured against — any rectangle a mode may be. */
export interface BoardShape {
  columns: number;
  rows: number;
}

/**
 * The side that wins by standing on this tile, or null when standing there
 * wins nothing.
 *
 * At most one side per tile: no mode gives both the same goal, and the two
 * that have goals put them at opposite ends of a board at least three tiles
 * across.
 */
export const goalOwnerAt = (
  modeId: ModeID | undefined,
  x: number,
  y: number,
  shape: BoardShape,
): SideColor | null => {
  if (modeId === MODE_INFILTRATION) {
    if (y === 0) return 'Red';
    if (y === shape.rows - 1) return 'Blue';
    return null;
  }
  if (modeId === MODE_INTRANSITIVE) {
    // One end of each of Infiltration's two goal ranks: Red still races at rank
    // 0 and Blue at the last, and the mode just names the file as well. Blue
    // opens in the a1 corner, so that is the tile Red is running at.
    if (x === 0 && y === 0) return 'Red';
    if (x === shape.columns - 1 && y === shape.rows - 1) return 'Blue';
    return null;
  }
  return null;
};

/**
 * How a mode records the win, or null in a mode nothing is won by arriving in.
 *
 * Separate reasons rather than one shared "arrived", because the two are
 * different enough to be worth different words on the result card: a rank
 * crossed and a corner taken.
 */
export const goalEndReason = (modeId: ModeID | undefined): GameEndReason | null =>
  modeId === MODE_INFILTRATION
    ? 'infiltration'
    : modeId === MODE_INTRANSITIVE
      ? 'corner'
      : null;

/** Whether this mode is won by getting a piece somewhere. */
export const hasGoalTiles = (modeId: ModeID | undefined) => goalEndReason(modeId) !== null;
