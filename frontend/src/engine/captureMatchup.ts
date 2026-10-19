// Which throw won a capture, read off the two boards either side of it.
//
// Two things say it out loud: the capture sound and the board's capture effect.
// Both read the capture here, from one function, so the clip and the picture
// cannot disagree about who took whom. They used to be able to: the sound went
// looking for the square that emptied — the taker's own square — and named its
// clip from that piece as if it were the one that fell, so every capture played
// the clip of the matchup after it in the cycle. The clip is named by
// `captureSoundFor` in `@/appearance/gameSound`, from the piece that fell, and
// the tests hold that table and `captureMatchup` below to the same three answers.

import type { Grid, Piece, PlayerColor, Position } from '@/types/game';

/**
 * The three ways a capture can go, named the way the sound clips are.
 *
 * `canCapture` is one three-cycle in every mode, so there are no others.
 */
export type CaptureMatchup = 'rockTakesScissors' | 'scissorsTakesPaper' | 'paperTakesRock';

const MATCHUPS: Record<string, CaptureMatchup> = {
  'rock>scissors': 'rockTakesScissors',
  'scissors>paper': 'scissorsTakesPaper',
  'paper>rock': 'paperTakesRock',
};

/**
 * The matchup one kind taking another makes, or `null` when the pair is not one.
 *
 * Case-blind, so a kind's id (`Rock`) and an artwork name (`rock`) read alike:
 * the board asks with the artwork a kind is drawn as, which is what a mode's own
 * kinds borrow.
 */
export const captureMatchup = (
  attacker: string | undefined,
  victim: string | undefined,
): CaptureMatchup | null =>
  attacker && victim
    ? (MATCHUPS[`${attacker.toLowerCase()}>${victim.toLowerCase()}`] ?? null)
    : null;

/** A piece as a capture saw it. */
export interface CapturePiece {
  piece: Piece;
  color: PlayerColor;
}

/** One capture: where the taker came from, where it landed, and who fell there. */
export interface Capture {
  from: Position;
  to: Position;
  attacker: CapturePiece;
  victim: CapturePiece;
}

/**
 * The capture that turned one board into the next, or `null` when the step
 * between them was anything else.
 *
 * Exactly two squares change in a capture: the taker's square empties, and the
 * square it lands on trades an enemy piece for it. Anything else is not one — a
 * quiet move, two moves at once, or the same capture played backwards, where
 * nothing empties and the fallen piece comes back — which is what lets a rewind
 * through a game pass over a capture without being told it is a rewind.
 */
export const captureBetweenGrids = (
  before: Grid | null | undefined,
  after: Grid | null | undefined,
): Capture | null => {
  if (!before?.length || !after || before.length !== after.length) return null;

  const changed: Position[] = [];
  for (let y = 0; y < before.length; y += 1) {
    const beforeRow = before[y];
    const afterRow = after[y];
    if (!beforeRow || !afterRow || beforeRow.length !== afterRow.length) return null;
    for (let x = 0; x < beforeRow.length; x += 1) {
      const was = beforeRow[x];
      const now = afterRow[x];
      if (!was || !now) return null;
      if (was.occupant !== now.occupant || was.occupantOwner !== now.occupantOwner) {
        changed.push({ x, y });
      }
    }
  }
  if (changed.length !== 2) return null;

  for (const from of changed) {
    const to = changed.find((position) => position !== from);
    if (!to) continue;
    const leaving = before[from.y]?.[from.x];
    const left = after[from.y]?.[from.x];
    const fallen = before[to.y]?.[to.x];
    const arrived = after[to.y]?.[to.x];
    if (!leaving || !left || !fallen || !arrived) continue;
    if (leaving.occupant === 'Empty' || left.occupant !== 'Empty') continue;
    if (arrived.occupant !== leaving.occupant || arrived.occupantOwner !== leaving.occupantOwner) {
      continue;
    }
    if (
      fallen.occupant === 'Empty' ||
      fallen.occupantOwner === 'Neutral' ||
      fallen.occupantOwner === leaving.occupantOwner
    ) {
      continue;
    }
    return {
      from,
      to,
      attacker: { piece: leaving.occupant, color: leaving.occupantOwner },
      victim: { piece: fallen.occupant, color: fallen.occupantOwner },
    };
  }
  return null;
};
