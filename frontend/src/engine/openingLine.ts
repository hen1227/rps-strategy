// Opening-book lines, replayed onto a board.
//
// The book stores a line as move notation and nothing else. Replayed from the
// mode's opening position that notation *is* the position, and shipping the
// boards as well would multiply an already nine-megabyte export by eighty-one.
// So every diagram the openings screen draws is produced here — by playing the
// line through the same rules module the analysis board, the bots and the
// replayed archive use, rather than by a second, diagram-only idea of how a
// piece moves.

import {
  applyAnalysisMove,
  createAnalysisGame,
  type AnalysisGame,
} from '@/engine/analysisGame';
import { OPENING_PLIES, type OpeningLine } from '@/engine/openingBook';
import { formatSquare, parseSquare } from '@/engine/pgn';
import type { ModeDefinition, Move, SideColor } from '@/types/game';

/**
 * A book move: `d9-c8`.
 *
 * RPSFish leaves out the piece letter and the capture marker PGN carries —
 * both are facts about the position, and a line is always replayed from the
 * start — but a line pasted out of a game record still has them. Accepting and
 * discarding them is exactly what the engine's own parser does.
 */
const BOOK_MOVE = /^[RPS]?([a-i][1-9])[-x][RPS]?([a-i][1-9])$/;

/** A move as the book spells it: `d9-c8`, squares only. */
export const formatBookMove = ({ from, to }: Move): string =>
  `${formatSquare(from)}-${formatSquare(to)}`;

export const parseBookMove = (notation: string | null | undefined): Move | null => {
  const match = BOOK_MOVE.exec((notation ?? '').trim());
  if (!match) return null;
  return { from: parseSquare(match[1]), to: parseSquare(match[2]) };
};

/**
 * A game's moves as a book line.
 *
 * Server games arrive with this already written — see `GameState.openingLine`,
 * which is the only way a player who refreshed or a spectator who arrived late
 * can have it at all. A bot game and a shared board have no server, so they
 * write their own here, from the record they are already keeping.
 */
export const openingLineOf = (
  moves: readonly Move[] | null | undefined,
  plies = OPENING_PLIES,
): string[] => (moves ?? []).slice(0, Math.max(0, plies)).map(formatBookMove);

/** One move of a line, and the board it produced. */
export interface OpeningStep {
  captured: boolean;
  /** The board after the move. */
  game: AnalysisGame;
  move: Move;
  mover: SideColor;
  notation: string;
}

/** Play one book move onto a board, or `null` when it is not legal there. */
export const playBookMove = (
  game: AnalysisGame | null | undefined,
  notation: string,
): OpeningStep | null => {
  const move = game ? parseBookMove(notation) : null;
  if (!game || !move) return null;
  const played = applyAnalysisMove(game, move.from, move.to);
  if (!played) return null;
  return {
    captured: played.captured,
    game: played.game,
    move,
    mover: played.mover,
    notation,
  };
};

/** A line replayed from the opening position. */
export interface OpeningWalk {
  /** The opening position itself, before any move. */
  start: AnalysisGame;
  /** One entry per move that could be played, in order. */
  steps: OpeningStep[];
  /**
   * True when the line ran out before its last move: a token this build cannot
   * read, or a move these rules refuse. The screen still has every board up to
   * that point, which is what it draws.
   */
  truncated: boolean;
}

export const walkOpeningLine = (
  mode: ModeDefinition | null | undefined,
  line: OpeningLine | null | undefined,
): OpeningWalk | null => {
  if (!mode?.startingPosition) return null;
  const start = createAnalysisGame(mode);
  const steps: OpeningStep[] = [];
  let game = start;
  for (const notation of line ?? []) {
    const step = playBookMove(game, notation);
    if (!step) return { start, steps, truncated: true };
    steps.push(step);
    game = step.game;
  }
  return { start, steps, truncated: false };
};

/** The board a walk reached: its last position, or the opening one. */
export const gameAfterWalk = (walk: OpeningWalk | null | undefined): AnalysisGame | null =>
  walk ? walk.steps[walk.steps.length - 1]?.game ?? walk.start : null;

/** The move that reached a walk's last position, for drawing it on the board. */
export const lastStepOfWalk = (walk: OpeningWalk | null | undefined): OpeningStep | null =>
  walk?.steps[walk.steps.length - 1] ?? null;
