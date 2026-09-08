// Work out which move turned one board into another.
//
// Two places need this and neither has the move: the live game receives a
// board snapshot with no record of what produced it, and undo on the bot board
// walks back to a position it kept without keeping the move. Both used to diff
// the grids themselves, in two copies that had already drifted apart.

import type { Grid, Move, Position } from '@/types/game';

/**
 * The move between two boards, or `null` when the difference is not one move.
 *
 * A move empties exactly one occupied square and changes exactly one other, so
 * the `from` is the square that emptied and the `to` is the square whose
 * occupant changed. A capture reads the same way, which is why the victim is
 * never needed here.
 */
export const inferMoveBetweenGrids = (
  before: Grid | null | undefined,
  after: Grid | null | undefined,
): Move | null => {
  if (!before || !after) return null;

  let from: Position | null = null;
  let to: Position | null = null;
  for (let y = 0; y < after.length; y += 1) {
    const afterRow = after[y];
    if (!afterRow) continue;
    for (let x = 0; x < afterRow.length; x += 1) {
      const beforeTile = before[y]?.[x];
      const afterTile = afterRow[x];
      if (!beforeTile || !afterTile) continue;

      if (beforeTile.occupant !== 'Empty' && afterTile.occupant === 'Empty') {
        from = { x, y };
      }
      if (
        afterTile.occupant !== 'Empty' &&
        (beforeTile.occupant !== afterTile.occupant ||
          beforeTile.occupantOwner !== afterTile.occupantOwner)
      ) {
        to = { x, y };
      }
    }
  }

  return from && to ? { from, to } : null;
};
