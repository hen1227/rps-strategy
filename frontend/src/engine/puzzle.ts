// What makes a position a puzzle.
//
// A puzzle is a position with exactly one answer, and this module is the test
// for "exactly one". It is the same test the opening book is certified with —
// a line runs while one continuation is strictly best, mirror twins folded, and
// stops at the first ply where that fails, carrying why it stopped. The test is
// on the *ranking* rather than on a score margin, which is the whole reason to
// spell it this way: a margin is a fitted number and goes stale the next time
// the evaluation is re-tuned, while "best" survives a re-tune by construction.
//
// Nothing here talks to the engine. It takes a finished `Analysis` and answers
// a question about it, so the rule can be tested against canned searches in a
// few milliseconds and the orchestration above it can be tested separately.

import { applyAnalysisMove, type AnalysisGame, type PositionLike } from './analysisGame';
import type { Analysis, EngineLine } from './rpsfish/protocol';
import {
  boardHeight,
  boardWidth,
  samePosition,
  type BoardSymmetry,
  type Grid,
  type Move,
  type Position,
} from '@/types/game';

/**
 * Why a line stopped where it did.
 *
 * Worth as much as the line itself: "three replies tie here" tells somebody
 * studying the position more than a line drawn arbitrarily through the branch,
 * and it is what stops an author publishing a five-move puzzle whose last two
 * moves nobody can be asked to find.
 */
export type CertificationStop =
  | 'ties'
  | 'unsettled'
  | 'over'
  | 'line-end'
  | 'diverged'
  | 'unsearchable';

/** What to tell somebody about a line that stopped. */
export const STOP_REASON_TEXT: Record<CertificationStop, string> = {
  ties: 'more than one move is equally best here',
  unsettled: 'the search did not settle on an answer here',
  over: 'the game is already over here',
  'line-end': "the author's line ends here",
  diverged: "the author's move is not the best one here",
  unsearchable: 'the engine cannot search this mode',
};

/** One certified ply: the move to find, and the spellings that are the same move. */
export interface CertifiedStep {
  move: Move;
  /** Reflections of `move` under a symmetry this board happens to have. */
  twins: Move[];
}

export type Certification =
  | { certified: true; step: CertifiedStep }
  | { certified: false; stop: CertificationStop };

// --- symmetry --------------------------------------------------------------

/**
 * Where a square lands under a relabelling.
 *
 * `mirror-files` reflects left to right; `diagonal` reflects across a1–i9, so
 * e3 and c5 trade places. Both are the server's own `BoardSymmetry` values.
 */
export const reflectSquare = (
  symmetry: BoardSymmetry,
  square: Position,
  grid: Grid,
): Position =>
  symmetry === 'mirror-files'
    ? { x: boardWidth(grid) - 1 - square.x, y: square.y }
    : { x: square.y, y: square.x };

const sameTile = (grid: Grid, a: Position, b: Position) => {
  const left = grid[a.y]?.[a.x];
  const right = grid[b.y]?.[b.x];
  if (!left || !right) return false;
  return (
    left.occupant === right.occupant &&
    left.occupantOwner === right.occupantOwner &&
    left.ownerColor === right.ownerColor
  );
};

/**
 * The relabellings this *particular* board is unchanged by.
 *
 * A mode declaring `mirror-files` says the rules do not care which way round
 * the files run; it does not say every board in it is symmetric. Only a board
 * that maps onto itself has twin moves, so the question is asked of the
 * position rather than answered from the mode alone — otherwise an asymmetric
 * board would have two genuinely different moves folded into one and a real tie
 * would be certified as a single answer.
 */
export const boardSymmetries = (
  grid: Grid,
  declared: readonly BoardSymmetry[] | undefined,
): BoardSymmetry[] => {
  const width = boardWidth(grid);
  const height = boardHeight(grid);
  return (declared ?? []).filter((symmetry) => {
    // A diagonal reflection is only a relabelling of a square board.
    if (symmetry === 'diagonal' && width !== height) return false;
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        if (!sameTile(grid, { x, y }, reflectSquare(symmetry, { x, y }, grid))) return false;
      }
    }
    return true;
  });
};

const sameMove = (a: Move, b: Move) => samePosition(a.from, b.from) && samePosition(a.to, b.to);

/** `move` under every symmetry this board has, itself excluded. */
export const twinsOf = (
  move: Move,
  grid: Grid,
  symmetries: readonly BoardSymmetry[],
): Move[] => {
  const seen: Move[] = [];
  for (const symmetry of symmetries) {
    const twin = {
      from: reflectSquare(symmetry, move.from, grid),
      to: reflectSquare(symmetry, move.to, grid),
    };
    if (sameMove(twin, move) || seen.some((kept) => sameMove(kept, twin))) continue;
    seen.push(twin);
  }
  return seen;
};

// --- the test --------------------------------------------------------------

/**
 * A search that has settled is one whose verdict another ply would not move.
 *
 * Nothing here reads a depth number, because any number would be a constant
 * fitted to one engine build. The engine already says why it stopped, and only
 * two of those reasons mean "I was still thinking": a search cut off by its
 * clock or its node ceiling was interrupted, and its ordering is provisional.
 */
const settled = (analysis: Analysis) =>
  analysis.stopReason !== 'time' &&
  analysis.stopReason !== 'nodes' &&
  analysis.stopReason !== 'cancelled' &&
  analysis.stopReason !== 'unknown';

const asMove = (line: EngineLine): Move => ({ from: line.from, to: line.to });

/**
 * Whether this position has exactly one best move, twins folded.
 *
 * The comparison is against the best move that is *not* a twin of the leader,
 * so a symmetric board offering one idea spelled two ways certifies, and a
 * board offering two different ideas of equal worth does not.
 *
 * One returned line is not evidence of uniqueness — it is evidence that one
 * line was asked for — so a single-variation search is unsettled rather than
 * certain. The exception is a position with one legal move, which the engine
 * reports as terminal-ish and nobody needs to find.
 */
export const certifyPosition = (
  analysis: Analysis | null | undefined,
  grid: Grid,
  declaredSymmetries: readonly BoardSymmetry[] | undefined,
): Certification => {
  if (!analysis) return { certified: false, stop: 'unsettled' };
  if (analysis.stopReason === 'no-legal-move' || analysis.stopReason === 'terminal') {
    return { certified: false, stop: 'over' };
  }
  const lines = analysis.lines ?? [];
  if (lines.length === 0) return { certified: false, stop: 'over' };
  if (!settled(analysis)) return { certified: false, stop: 'unsettled' };

  const [leader, ...rest] = lines;
  if (!leader) return { certified: false, stop: 'over' };
  const move = asMove(leader);
  const symmetries = boardSymmetries(grid, declaredSymmetries);
  const twins = twinsOf(move, grid, symmetries);

  const rivals = rest.filter((line) => !twins.some((twin) => sameMove(twin, asMove(line))));
  // Every other move is this one wearing a different hat: there is nothing to
  // tie with, and nothing more the search could have been asked.
  if (rivals.length === 0) {
    return lines.length > 1
      ? { certified: true, step: { move, twins } }
      : { certified: false, stop: 'unsettled' };
  }
  const best = rivals[0];
  if (!best || best.score >= leader.score) return { certified: false, stop: 'ties' };
  return { certified: true, step: { move, twins } };
};

/** Whether a solver's move is the one this step asks for, either spelling. */
export const stepAccepts = (step: CertifiedStep, played: Move) =>
  sameMove(step.move, played) || step.twins.some((twin) => sameMove(twin, played));

// --- walking a line --------------------------------------------------------

/**
 * One search, however the caller gets one.
 *
 * Injected rather than imported so the walk below can be tested against canned
 * searches. The real one is `analyzePosition` from `rpsfish/client`; a test
 * hands over a table of answers and never starts a worker.
 */
export type SearchPosition = (position: PositionLike) => Promise<Analysis | null>;

/** A line that has been walked: what the solver must find, and the defence. */
export interface CertifiedLine {
  /** The solver's plies, in order. Empty when the position is not a puzzle. */
  steps: CertifiedStep[];
  /** The opponent's reply after each step but the last. */
  replies: Move[];
  /** Why the line ends where it does. */
  stop: CertificationStop;
}

/**
 * Certify an author's intended line, and stop honestly where it stops.
 *
 * The author records only *their own* moves. The defence is the engine's, every
 * time, because a puzzle whose opponent cooperates is not a puzzle — and it is
 * one fewer thing to get right when writing one.
 *
 * A line that ends because the game ended is the good ending: the solver has
 * finished the job. A line that ends because three replies tie has still
 * produced a puzzle, just a shorter one than its author hoped.
 */
export const certifyLine = async ({
  start,
  intended,
  search,
}: {
  start: AnalysisGame;
  /** The solver's own moves, in order. */
  intended: readonly Move[];
  search: SearchPosition;
}): Promise<CertifiedLine> => {
  const steps: CertifiedStep[] = [];
  const replies: Move[] = [];
  const symmetries = start.mode.symmetries;
  let game = start;

  for (let index = 0; ; index += 1) {
    if (game.status !== 'InProgress') return { steps, replies, stop: 'over' };

    const verdict = certifyPosition(await search(game), game.grid, symmetries);
    if (!verdict.certified) return { steps, replies, stop: verdict.stop };

    const wanted = intended[index];
    // An author who has not said what comes next has said the line ends here.
    if (!wanted) return { steps, replies, stop: 'line-end' };
    if (!stepAccepts(verdict.step, wanted)) return { steps, replies, stop: 'diverged' };

    const played = applyAnalysisMove(game, wanted.from, wanted.to);
    if (!played) return { steps, replies, stop: 'diverged' };
    steps.push(verdict.step);
    game = played.game;

    if (game.status !== 'InProgress') return { steps, replies, stop: 'over' };

    // The defence. Not certified — the opponent is allowed a position where
    // several moves are equally awkward, and the engine simply picks one.
    const defence = (await search(game))?.lines?.[0];
    if (!defence) return { steps, replies, stop: 'over' };
    const reply = { from: defence.from, to: defence.to };
    const answered = applyAnalysisMove(game, reply.from, reply.to);
    if (!answered) return { steps, replies, stop: 'unsettled' };
    replies.push(reply);
    game = answered.game;
  }
};
