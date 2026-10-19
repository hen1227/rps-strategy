// Solving a position: does this move answer what was asked?
//
// A position somebody was set, rather than a game somebody is playing. Whoever
// set it chose the board and the side to move, and the one question asked of a
// move is whether it answers them: a lesson asks "take the scissors", a puzzle
// asks for its one best move. Either way a move is one of three things — not
// legal here, legal but not the answer, or the answer — and it is judged on the
// board it leads to, by the same rules every other board here plays by.
//
// Nothing in this file knows a lesson or a puzzle. `features/learn/lessons.ts`
// is the first set of positions; a puzzle of the day would be a second, written
// with `oneOf` because a stored puzzle is a list of moves rather than a rule.
// `puzzle.ts` beside this is the other half of that feature: it certifies that
// a position has exactly one answer before anybody is asked to find it.

import {
  allValidMoves,
  applyAnalysisMove,
  createAnalysisGameOn,
  stepTargets,
  type AnalysisGame,
  type AppliedMove,
  type StartingBoard,
} from './analysisGame';
import {
  samePosition,
  type Grid,
  type ModeDefinition,
  type Move,
  type Position,
  type SideColor,
} from '@/types/game';

/** A board to play one move on, and the test that move has to pass. */
export interface SolvePosition {
  board: StartingBoard;
  /**
   * Whether `move` answers the position. Only ever asked of a legal move, and
   * handed the board the move leads to as well as the one it was played on, so
   * a rule can be about what the move *did* — "the paper is out of reach" —
   * rather than a list of squares somebody had to get exactly right.
   */
  solves: (move: Move, after: AnalysisGame, before: AnalysisGame) => boolean;
  /**
   * The reply that shows why a wrong move is wrong, played on the board it led
   * to before it is taken back: the scissors that takes the paper, the paper
   * that walks into the corner. `null`, or no `refute` at all, when a wrong
   * move has no one reply that says it better than the hint does.
   */
  refute?: (move: Move, after: AnalysisGame) => Move | null;
}

export type SolveVerdict = 'solved' | 'wrong';

export interface JudgedMove {
  verdict: SolveVerdict;
  /** The move played, so a wrong answer can be shown before it is taken back. */
  applied: AppliedMove;
}

/** The game a position is solved on, ready for its first move. */
export const solveGame = (mode: ModeDefinition, position: SolvePosition): AnalysisGame =>
  createAnalysisGameOn(mode, position.board);

/**
 * Judge one move, or `null` when it is not legal here.
 *
 * An illegal move is not a wrong answer. The board never offers one, and a
 * drag that lands somewhere illegal springs back the way it does on every other
 * board, so there is nothing to tell the player that the board has not already.
 */
export const judgeSolveMove = (
  position: SolvePosition,
  game: AnalysisGame,
  from: Position,
  to: Position,
): JudgedMove | null => {
  const applied = applyAnalysisMove(game, from, to);
  if (!applied) return null;
  return {
    applied,
    verdict: position.solves({ from, to }, applied.game, game) ? 'solved' : 'wrong',
  };
};

/** A test that passes for these moves and no others. */
export const oneOf =
  (...answers: Move[]): SolvePosition['solves'] =>
  (move) =>
    answers.some(
      (answer) => samePosition(answer.from, move.from) && samePosition(answer.to, move.to),
    );

/**
 * A legal move for the side to move that lands on `square`, or `null`.
 *
 * The usual refutation: whatever stands on the square is taken, or the empty
 * square is the one that mattered.
 */
export const moveOnto = (game: AnalysisGame, square: Position): Move | null =>
  allValidMoves(game).find((candidate) => samePosition(candidate.to, square)) ?? null;

/**
 * Whether any piece of `side` could step onto `square` on its next move — into
 * it if it is empty, or by taking whatever stands there.
 *
 * Asked of the board as it stands, whoever is to move, because "can anything of
 * theirs reach this?" is a question about the pieces and not about the turn.
 * The movement rule is `stepTargets`, the one the reach maps and every legal
 * move list use, so nothing here can disagree with the board about a capture.
 */
export const reachableBy = (grid: Grid, square: Position, side: SideColor): boolean =>
  grid.some((row) =>
    row.some(
      (tile) =>
        tile.occupantOwner === side &&
        tile.occupant !== 'Empty' &&
        stepTargets(grid, { x: tile.x, y: tile.y }, side, tile.occupant).some((target) =>
          samePosition(target, square),
        ),
    ),
  );
