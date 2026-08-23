// Turn a stored game into a report: an evaluation for every position, a grade
// for every move, and an accuracy for each player.
//
// Three decisions are worth stating plainly, because everything a player sees
// on the review screen follows from them. They are argued for in
// `docs/review.md`.
//
//   1. A move is graded against the best move *from the same search*. The
//      worker restricts one search to {best move, played move} when the played
//      move is not already in the returned lines, so the two numbers being
//      subtracted were produced under identical conditions.
//   2. Centipawns are converted to expected score before anything is judged.
//      Fifty centipawns is a catastrophe in a level position and noise in a
//      won one; a probability says so and a centipawn does not. The
//      conversion is fitted from self-play, not assumed —
//      `scripts/reviewCalibration.mts` measures it.
//   3. Accuracy is Lichess's formulation, unchanged. It takes win-percentage
//      points, which are already game-independent once the conversion above is
//      calibrated, so borrowing a curve people have compared against for years
//      beats inventing one nobody has.

import {
  allValidMoves,
  applyAnalysisMove,
  createAnalysisGameFrom,
  type AnalysisGame,
} from './analysisGame';
import { decodePosition, parsePGN, winnerFromResult, type GameResult } from './pgn';
import type { ReviewEntry } from './rpsfish/protocol';
import type {
  GameEndReason,
  ModeDefinition,
  ModeID,
  Move,
  Piece,
  PlayablePiece,
  PlayerColor,
  Position,
  SideColor,
} from '@/types/game';

/**
 * How steeply an evaluation turns into an expected score, per mode.
 *
 * Fitted by `npm run calibrate:review`, which plays games, records the
 * evaluation at every position, and finds the logistic that best predicts the
 * result those games actually reached. These are measurements; re-run the
 * script after an evaluation change rather than adjusting them by feel.
 */
export const WIN_PROBABILITY_SCALE: Partial<Record<ModeID, number>> = Object.freeze({
  // Measured 2026-08-22 from 150 self-play games per mode at depth 8
  // (`--games 150 --depth 8 --plies 400 --seed 20260821`). The comment is the
  // score at which the side to move expects three points in four, which is
  // the legible form of the same number.
  V1: 0.006_187, // Annihilation, 75% at 178 centipawns
  // Total War was 0.003_848 (75% at 286cp) until the mode's territory
  // evaluation was re-priced (RPSFish EVAL_RESULTS.md H9). Re-fitted on the
  // same protocol on two fresh seeds: 0.003_380 (seed 6180339) and 0.003_091
  // (1414213), ~30,600 positions each. This is their mean.
  //
  // Read the two control modes before trusting any single run of this script:
  // re-measured on seed 6180339 with *unchanged* weights, V1 came back 5.5%
  // low and V3 28% high, so one fit is not evidence of a shift. Two seeds
  // agreeing in direction, on the mode with five times V3's sample, is. The
  // direction is what the re-pricing implies: Total War has two win
  // conditions and the evaluation now states the territory one far more
  // weakly, so a given score predicts the result less sharply and the same
  // confidence needs more centipawns.
  V5: 0.003_236, // Total War, 75% at 340 centipawns
  V3: 0.004_949, // Infiltration, 75% at 222 centipawns
});

// A mode nobody has calibrated yet gets the middle of the three rather than a
// guess of its own.
const DEFAULT_SCALE = 0.004_949;
const MATE_THRESHOLD = 29_000;
// Beyond this the logistic is already pinned; clamping keeps a mate score from
// turning into an infinity halfway through an average.
const SCORE_CLAMP = 4_000;

const scaleFor = (modeId: ModeID) => WIN_PROBABILITY_SCALE[modeId] ?? DEFAULT_SCALE;

/**
 * The expected score, in percent, for the side a score belongs to.
 *
 * "Expected score" rather than "win probability": a draw is half a point, and
 * in these modes draws are common enough that pretending otherwise would
 * misprice every quiet position.
 */
export const winPercent = (score: number | null | undefined, modeId: ModeID) => {
  if (score === null || score === undefined || !Number.isFinite(score)) return 50;
  if (score >= MATE_THRESHOLD) return 100;
  if (score <= -MATE_THRESHOLD) return 0;
  const clamped = Math.max(-SCORE_CLAMP, Math.min(SCORE_CLAMP, score));
  return 100 / (1 + Math.exp(-scaleFor(modeId) * clamped));
};

/**
 * The score at which a side is already expected to take 95% of the point.
 *
 * Past it the game is decided and further centipawns mean nothing, which is
 * why average centipawn loss is measured with both scores pulled back to this
 * bound: without it a single missed forced win, worth tens of thousands of
 * nominal centipawns, would be the entire average.
 */
export const decisiveScore = (modeId: ModeID) => Math.log(19) / scaleFor(modeId);

/**
 * Lichess's accuracy curve, applied to expected-score points lost.
 *
 * Exactly the published constants. The curve's job is to turn "you gave away
 * eight points of expected score" into a number a human reads as a school
 * grade, and that job does not depend on which game produced the eight points.
 */
export const moveAccuracy = (winPercentBefore: number, winPercentAfter: number) => {
  const lost = Math.max(0, winPercentBefore - winPercentAfter);
  const raw = 103.1668 * Math.exp(-0.043_54 * lost) - 3.166_9;
  return Math.max(0, Math.min(100, raw));
};

export type GradeKey =
  | 'best'
  | 'great'
  | 'excellent'
  | 'good'
  | 'inaccuracy'
  | 'mistake'
  | 'blunder';

export interface MoveGrade {
  key: GradeKey;
  label: string;
  symbol: string;
  /** The most expected-score a move may give up and still earn this grade. */
  maxLoss: number;
}

export const MOVE_GRADES: readonly MoveGrade[] = Object.freeze([
  { key: 'best', label: 'Best', symbol: '★', maxLoss: 0 },
  { key: 'great', label: 'Great', symbol: '!', maxLoss: 0 },
  { key: 'excellent', label: 'Excellent', symbol: '✓', maxLoss: 2 },
  { key: 'good', label: 'Good', symbol: '.', maxLoss: 5 },
  { key: 'inaccuracy', label: 'Inaccuracy', symbol: '?!', maxLoss: 10 },
  { key: 'mistake', label: 'Mistake', symbol: '?', maxLoss: 20 },
  { key: 'blunder', label: 'Blunder', symbol: '??', maxLoss: Infinity },
] as const satisfies readonly MoveGrade[]);

const gradeByKey = (key: GradeKey): MoveGrade => {
  const grade = MOVE_GRADES.find((candidate) => candidate.key === key);
  if (!grade) throw new Error(`${key} is not a move grade.`);
  return grade;
};

const BEST_GRADE = gradeByKey('best');
const GREAT_GRADE = gradeByKey('great');
const LOSS_GRADES = MOVE_GRADES.filter((grade) => grade.key !== 'best' && grade.key !== 'great');
const WORST_GRADE = LOSS_GRADES[LOSS_GRADES.length - 1] ?? gradeByKey('blunder');
const GOOD_MOVE_MAX_LOSS = gradeByKey('good').maxLoss;

/**
 * Whether the engine's first line was the only move that still grades Good.
 *
 * MultiPV is ordered, so if line two gives up more than the Good threshold,
 * every later legal move does too. That makes this a measurable version of
 * the conventional Chess.com-style Great Move rather than a decorative `!`.
 */
export const isOnlyGoodMove = (
  bestScore: number | null | undefined,
  secondBestScore: number | null | undefined,
  modeId: ModeID,
) => {
  if (!Number.isFinite(bestScore) || !Number.isFinite(secondBestScore)) return false;
  const lossPercent = Math.max(
    0,
    winPercent(bestScore, modeId) - winPercent(secondBestScore, modeId),
  );
  return lossPercent > GOOD_MOVE_MAX_LOSS;
};

/**
 * Grade one move by the expected score it gave away.
 *
 * The engine's own choice is Best unless it was the only Good move, in which
 * case it earns Great. A top move cannot be a loss-based inaccuracy because
 * nothing better exists.
 */
export const gradeMove = ({
  lossPercent,
  isOnlyGoodMove: onlyGood = false,
  isTopMove,
}: {
  lossPercent: number;
  isOnlyGoodMove?: boolean;
  isTopMove: boolean;
}): MoveGrade => {
  if (isTopMove) return onlyGood ? GREAT_GRADE : BEST_GRADE;
  return LOSS_GRADES.find((grade) => lossPercent <= grade.maxLoss) ?? WORST_GRADE;
};

/** A grade, plus the two numbers it was read off. */
export interface GradedAgainstBest extends MoveGrade {
  lossPercent: number;
  accuracy: number;
}

/**
 * Grade one move from two scores taken in the same search.
 *
 * The analysis board and the review both end up here, so a move cannot be
 * "Good" on one screen and a "Mistake" on the other.
 */
export const gradeAgainstBest = (
  bestScore: number | null | undefined,
  playedScore: number | null | undefined,
  modeId: ModeID,
  isTopMove = false,
  secondBestScore: number | null = null,
): GradedAgainstBest => {
  const before = winPercent(bestScore, modeId);
  const after = winPercent(playedScore, modeId);
  const lossPercent = Math.max(0, before - after);
  const onlyGood = isTopMove && isOnlyGoodMove(bestScore, secondBestScore, modeId);
  return {
    ...gradeMove({ lossPercent, isOnlyGoodMove: onlyGood, isTopMove }),
    lossPercent,
    accuracy: moveAccuracy(before, after),
  };
};

const standardDeviation = (values: number[]) => {
  if (values.length === 0) return 0;
  const mean = values.reduce((total, value) => total + value, 0) / values.length;
  const variance =
    values.reduce((total, value) => total + (value - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
};

/**
 * Combine one player's move accuracies into a game accuracy.
 *
 * Two means, averaged. The weighted mean makes a move in a volatile stretch of
 * the game count for more than one in a dead-drawn ending, because that is
 * where the game was actually decided. The harmonic mean refuses to let a
 * string of forced recaptures bury a blunder. Neither alone behaves; the pair
 * is what Lichess settled on and it holds up here for the same reason.
 */
export const combineAccuracies = (accuracies: number[], weights: number[]) => {
  if (accuracies.length === 0) return null;
  const totalWeight = weights.reduce((total, weight) => total + weight, 0);
  const weightedMean =
    totalWeight > 0
      ? accuracies.reduce((total, value, index) => total + value * (weights[index] ?? 0), 0) /
        totalWeight
      : accuracies.reduce((total, value) => total + value, 0) / accuracies.length;
  const harmonicMean =
    accuracies.length /
    accuracies.reduce((total, value) => total + 1 / Math.max(value, 0.5), 0);
  return Math.max(0, Math.min(100, (weightedMean + harmonicMean) / 2));
};

// --- reading a record ------------------------------------------------------

const MODE_FALLBACK_ROWS = [
  '...SSS...', '...PPP...', '...RRR...',
  '.........', '.........', '.........',
  '...rrr...', '...ppp...', '...sss...',
];

export class ReviewError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReviewError';
  }
}

const modeFor = (
  modes: ModeDefinition[] | null | undefined,
  modeId: ModeID,
  variant: string,
): ModeDefinition => {
  const known = modes?.find((mode) => mode.id === modeId);
  if (known) return known;
  // A retired mode keeps its games. Reviewing one only needs its id, which is
  // what the rules switch on, so a minimal stand-in beats refusing to open it.
  return {
    id: modeId,
    shortCode: modeId,
    name: variant || modeId,
    description: '',
    objective: '',
    displayOrder: 0,
    playable: false,
    features: modeId === 'V5' ? ['territory'] : [],
    startingPosition: { rows: MODE_FALLBACK_ROWS },
  };
};

const numberTag = (parsed: { tag: (name: string) => string }, name: string) => {
  const value = Number.parseInt(parsed.tag(name), 10);
  return Number.isFinite(value) ? value : null;
};

/** One move of a record: the move, whose it was, and what it cost on the clock. */
export interface RecordedMove extends Move {
  player: SideColor;
  captured: Piece;
  // Always a real piece: a move token names the attacker, so a recorded move
  // that moved nothing could not have been written down.
  piece: PlayablePiece;
  elapsedMs: number | null;
  redRemainingMs: number | null;
  blueRemainingMs: number | null;
}

/** Who a record says played a side. */
export interface RecordedPlayer {
  name: string;
  userId: string;
  elo: number | null;
  eloAfter: number | null;
}

/**
 * A record, replayed: the line of positions, the moves that made it, and
 * everything the tags say about the game around it.
 */
export interface ReviewSource {
  mode: ModeDefinition;
  positions: AnalysisGame[];
  moves: RecordedMove[];
  gameId: string;
  event: string;
  /** Opening moves that were dealt rather than chosen. */
  bookPlies: number;
  seriesId: string | null;
  ranked: boolean;
  result: GameResult;
  winner: PlayerColor;
  endReason: GameEndReason | string | null;
  endedBy: string | null;
  termination: string;
  players: Record<SideColor, RecordedPlayer>;
  startedAtUnixMs: number | null;
  pgn: string;
}

/**
 * Replay an archived game into the positions a review needs.
 *
 * The rules run here, not on the server: every position is produced by the
 * same `applyAnalysisMove` the analysis board and the bot game use, so a
 * record that replays is a record this client can also play on from.
 */
export const reviewSourceFromPGN = (
  pgnText: string,
  modes: ModeDefinition[] | null | undefined,
): ReviewSource => {
  const parsed = parsePGN(pgnText);
  const modeId = parsed.tag('ModeId');
  if (!modeId) throw new ReviewError('This record does not say which mode it was played in.');
  const mode = modeFor(modes, modeId, parsed.tag('Variant'));

  const setUp = parsed.tag('FEN');
  const start = setUp
    ? (() => {
        const { grid, currentTurn } = decodePosition(setUp);
        return createAnalysisGameFrom(mode, grid, currentTurn === 'Blue' ? 'Blue' : 'Red');
      })()
    : createAnalysisGameFrom(mode, decodePosition(MODE_FALLBACK_ROWS.join('/')).grid, 'Red');

  const positions: AnalysisGame[] = [start];
  const moves: RecordedMove[] = [];
  let game = start;
  for (const event of parsed.events) {
    if (event.kind !== 'move') continue;
    const result = applyAnalysisMove(game, event.from, event.to);
    if (!result) {
      throw new ReviewError(
        `Move ${moves.length + 1} in this record is not legal on the board it replays into.`,
      );
    }
    moves.push({
      from: event.from,
      to: event.to,
      player: result.mover,
      captured: event.captured,
      piece: event.piece,
      elapsedMs: event.elapsedMs ?? null,
      redRemainingMs: event.redRemainingMs ?? null,
      blueRemainingMs: event.blueRemainingMs ?? null,
    });
    game = result.game;
    positions.push(game);
  }

  // `[%end reason player]` names whoever caused the ending, not whoever won:
  // a resignation names the player who resigned. The result token is the only
  // thing that says who won, so it is what the winner is read from.
  const ending = [...parsed.events].reverse().find((event) => event.kind === 'end');
  return {
    mode,
    positions,
    moves,
    gameId: parsed.tag('GameId'),
    event: parsed.tag('Event'),
    // Opening moves that were dealt rather than chosen. A bot series starts
    // each pair from a seeded random opening, and grading those as though
    // somebody picked them would misreport both engines' accuracy.
    bookPlies: Number.parseInt(parsed.tag('BookPlies'), 10) || 0,
    seriesId: parsed.tag('SeriesId') || null,
    ranked: parsed.tag('Ranked') === 'true',
    result: parsed.result,
    winner: winnerFromResult(parsed.result),
    endReason: ending?.reason || parsed.tag('EndReason') || null,
    endedBy: ending?.player ?? null,
    termination: parsed.tag('Termination'),
    players: {
      Red: {
        name: parsed.tag('Red'),
        userId: parsed.tag('RedId'),
        elo: numberTag(parsed, 'RedElo'),
        eloAfter: numberTag(parsed, 'RedEloAfter'),
      },
      Blue: {
        name: parsed.tag('Blue'),
        userId: parsed.tag('BlueId'),
        elo: numberTag(parsed, 'BlueElo'),
        eloAfter: numberTag(parsed, 'BlueEloAfter'),
      },
    },
    startedAtUnixMs: numberTag(parsed, 'StartTimeUnixMs'),
    pgn: pgnText,
  };
};

/** Every legal continuation of a reviewed position, for free play off the line. */
export const branchesFrom = (game: AnalysisGame) => allValidMoves(game);

// --- turning engine entries into a report ----------------------------------

/**
 * The least a move must carry to be graded: where it went, and whose it was.
 *
 * Everything below is generic over it. A record's moves carry clocks and
 * captured pieces; an analysis board's carry nothing but this. Both are graded
 * by the same walk, and the report hands back whatever it was given rather than
 * flattening it to a lowest common denominator.
 */
export interface GradableMove extends Move {
  player: SideColor;
}

/** A move the walk has not reached yet. */
export type PendingMove<TMove extends GradableMove = RecordedMove> = TMove & {
  index: number;
  pending: true;
  isBook: boolean;
};

/** A move the walk has graded. */
export type GradedMove<TMove extends GradableMove = RecordedMove> = TMove & {
  index: number;
  pending: false;
  isBook: boolean;
  bestMove: Move | null;
  bestScore: number | null;
  playedScore: number;
  lossCentipawns: number;
  lossPercent: number;
  accuracy: number;
  grade: MoveGrade;
  isOnlyGoodMove: boolean;
  isTopMove: boolean;
  depth: number;
};

export type ReviewMove<TMove extends GradableMove = RecordedMove> =
  | PendingMove<TMove>
  | GradedMove<TMove>;

/** One point of the evaluation curve, always from Red's side. */
export interface EvaluationPoint {
  index: number;
  redScore: number;
}

/** The same point, converted to the axis a chart should actually plot. */
export interface ExpectedScorePoint {
  index: number;
  redPercent: number;
}

/**
 * The curve a chart draws: expected score, not centipawns.
 *
 * A chart of raw evaluation is mostly a chart of one forced sequence at the
 * end — the moment a mate appears the axis rescales and everything before it
 * flattens. Both the review and the bot battle plot this, so the conversion
 * lives here rather than in each of them.
 */
export const expectedScoreCurve = (
  evaluations: EvaluationPoint[],
  modeId: ModeID,
): ExpectedScorePoint[] =>
  evaluations.map((point) => ({
    index: point.index,
    redPercent: winPercent(point.redScore, modeId),
  }));

export interface PlayerAccuracy {
  accuracy: number | null;
  moveCount: number;
  averageLossPercent: number;
  averageLossCentipawns: number;
  grades: Record<GradeKey, number>;
}

export interface ReviewReport<TMove extends GradableMove = RecordedMove> {
  moves: ReviewMove<TMove>[];
  evaluations: EvaluationPoint[];
  accuracy: Record<SideColor, PlayerAccuracy | null>;
  complete: boolean;
  analyzed: number;
  total: number;
}

/** The parts of a source the summary actually reads. */
export interface SummarySource<TMove extends GradableMove = RecordedMove> {
  mode: ModeDefinition;
  moves: TMove[];
  positions: unknown[];
}

/**
 * Fold the worker's per-position entries into the report the screen renders.
 *
 * `entries` may be partial: the review streams, and a half-finished report is
 * still worth showing. Accuracy is only reported once every move of a colour
 * has been graded, because an average over the first ten moves of a game is
 * not that player's accuracy and should not be labelled as one.
 *
 * `bookPlies` is how many opening moves were dealt rather than chosen — a bot
 * series starts each pair from a seeded random opening, recorded in the PGN's
 * BookPlies tag. Those moves are still graded, because the evaluation curve
 * would have a hole in it otherwise, but they are marked and left out of the
 * accuracy average: blaming an engine for a move nobody made is a lie about
 * how well it played.
 */
export const summarizeReview = <TMove extends GradableMove = RecordedMove>({
  source,
  entries,
  bookPlies = 0,
}: {
  source: SummarySource<TMove>;
  entries: ReviewEntry[];
  bookPlies?: number;
}): ReviewReport<TMove> => {
  const modeId = source.mode.id;
  const bound = decisiveScore(modeId);
  const clamp = (score: number | null | undefined) =>
    Math.max(-bound, Math.min(bound, score ?? 0));
  const graded: ReviewMove<TMove>[] = source.moves.map((move, index) => {
    const entry = entries[index];
    if (!entry || entry.playedScore === null || entry.playedScore === undefined) {
      return { ...move, index, pending: true, isBook: index < bookPlies };
    }
    const before = winPercent(entry.baselineScore, modeId);
    const after = winPercent(entry.playedScore, modeId);
    const lossPercent = Math.max(0, before - after);
    const top = entry.analysis.lines[0] ?? null;
    const isTopMove = Boolean(
      top &&
        top.from.x === move.from.x &&
        top.from.y === move.from.y &&
        top.to.x === move.to.x &&
        top.to.y === move.to.y,
    );
    const onlyGood =
      isTopMove && isOnlyGoodMove(entry.baselineScore, entry.analysis.lines[1]?.score, modeId);
    return {
      ...move,
      index,
      pending: false,
      isBook: index < bookPlies,
      bestMove: top ? { from: top.from, to: top.to } : null,
      bestScore: entry.baselineScore,
      playedScore: entry.playedScore,
      lossCentipawns: Math.max(0, clamp(entry.baselineScore) - clamp(entry.playedScore)),
      lossPercent,
      accuracy: moveAccuracy(before, after),
      grade: gradeMove({ lossPercent, isOnlyGoodMove: onlyGood, isTopMove }),
      isOnlyGoodMove: onlyGood,
      isTopMove,
      depth: entry.analysis.depth,
    };
  });

  // The evaluation line the chart draws: one point per position, always from
  // Red's side, so the curve reads the same way for both players.
  const evaluations = entries
    .filter(Boolean)
    .map((entry) => ({ index: entry.index, redScore: entry.analysis.redScore }));

  // Volatility weights come from a sliding window over the whole game, so a
  // move is weighted by how much was at stake around it rather than by
  // anything about the move itself.
  const winPercents: number[] = [];
  for (let index = 0; index <= source.moves.length; index += 1) {
    const entry = entries[index];
    winPercents.push(entry ? winPercent(entry.analysis.redScore, modeId) : 50);
  }
  const windowSize = Math.max(2, Math.min(8, Math.ceil(winPercents.length / 10)));
  const weightAt = (index: number) => {
    const start = Math.max(0, index - windowSize + 1);
    const window = winPercents.slice(start, Math.max(start + 2, index + 1));
    return Math.max(0.5, Math.min(12, standardDeviation(window)));
  };

  const isGraded = (move: ReviewMove<TMove>): move is GradedMove<TMove> => !move.pending;
  const accuracy: Record<SideColor, PlayerAccuracy | null> = { Red: null, Blue: null };
  for (const color of ['Red', 'Blue'] as const) {
    const own = graded.filter((move) => move.player === color && !move.isBook);
    if (own.length === 0 || !own.every(isGraded)) {
      accuracy[color] = null;
      continue;
    }
    accuracy[color] = {
      accuracy: combineAccuracies(
        own.map((move) => move.accuracy),
        own.map((move) => weightAt(move.index)),
      ),
      moveCount: own.length,
      averageLossPercent: own.reduce((total, move) => total + move.lossPercent, 0) / own.length,
      averageLossCentipawns:
        own.reduce((total, move) => total + move.lossCentipawns, 0) / own.length,
      grades: MOVE_GRADES.reduce(
        (counts, grade) => {
          counts[grade.key] = own.filter((move) => move.grade.key === grade.key).length;
          return counts;
        },
        {} as Record<GradeKey, number>,
      ),
    };
  }

  return {
    moves: graded,
    evaluations,
    accuracy,
    complete: entries.length > source.moves.length && graded.every((move) => !move.pending),
    analyzed: entries.filter(Boolean).length,
    total: source.positions.length,
  };
};
