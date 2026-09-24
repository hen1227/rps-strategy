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
 * Which side of the 2026-09-03 board flip a position is being judged on.
 *
 * `current` is today's rules and the answer for everything except an archived
 * record. `preChange` is the board as it was written before that day, when the
 * ranks ran the other way and the colours were the other way round: Red opened
 * from the top and raced for i1, Blue from the bottom for a9.
 *
 * It exists because a record is replayed, not re-derived. An archived game
 * carries the board it was played from, and the moves in it are legal either
 * way — movement is eight-connected and captures depend only on the two pieces
 * — so the *only* thing that reads differently under today's rules is which
 * square ends the game. A pre-change Intransitive record replayed against
 * today's corners finishes on the wrong square or, worse, on the right square
 * several moves early, and the reader sees an error rather than a game.
 *
 * The backend's opening-statistics compiler answers the same question by
 * flipping the record onto today's board (see `game/rank_flip.go`). Review
 * cannot do that: flipping renames the colours, and a review has the players'
 * names on the Red and Blue seats and the result token to agree with. So the
 * record stays as written and the *goals* move instead, which is the same
 * relabelling read from the other end.
 */
export type RulesEra = 'current' | 'preChange';

/** Red and Blue exchanged; the other half of the rank flip. */
const swapSide = (side: SideColor | null): SideColor | null =>
  side === 'Red' ? 'Blue' : side === 'Blue' ? 'Red' : null;

/**
 * The side that wins by standing on this tile, or null when standing there
 * wins nothing.
 *
 * At most one side per tile: no mode gives both the same goal, and the two
 * that have goals put them at opposite ends of a board at least three tiles
 * across.
 *
 * A `preChange` board is answered by running today's rule at the mirrored rank
 * and swapping the side, rather than by a second table of coordinates. That is
 * exactly the rank flip — reverse the ranks, swap the colours — and deriving it
 * is what keeps the two eras from drifting apart: a mode whose goal moves has
 * one place to move it. It also lands on the right answer for the modes that
 * did not change. Infiltration's goal ranks are each other's images, so the
 * flip returns them unaltered and V3 and V5 read identically in both eras,
 * which is why the board flip only ever showed up in V6.
 */
export const goalOwnerAt = (
  modeId: ModeID | undefined,
  x: number,
  y: number,
  shape: BoardShape,
  era: RulesEra = 'current',
): SideColor | null => {
  if (era === 'preChange') {
    return swapSide(goalOwnerAt(modeId, x, shape.rows - 1 - y, shape));
  }
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
