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
  startingPositionFromGrid,
  type AnalysisGame,
} from './analysisGame';
import type { RulesEra } from './goals';
import { decodePosition, parsePGN, winnerFromResult, type GameResult } from './pgn';
import type { ReviewEntry } from './rpsfish/protocol';
import {
  FIRST_TO_MOVE,
  type GameEndReason,
  type Grid,
  type ModeDefinition,
  type ModeFeature,
  type ModeID,
  type Move,
  type Piece,
  type PlayablePiece,
  type PlayerColor,
  type Position,
  type SideColor,
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
  // Total War was 0.003_848 (75% at 286cp) until the mode's territory
  // evaluation was re-priced (RPSFish EVAL_RESULTS.md H9). Re-fitted on the
  // same protocol on two fresh seeds: 0.003_380 (seed 6180339) and 0.003_091
  // (1414213), ~30,600 positions each. This is their mean.
  //
  // Read the control modes before trusting any single run of this script:
  // re-measured on seed 6180339 with *unchanged* weights, the since-retired V1
  // came back 5.5% low and V3 28% high, so one fit is not evidence of a shift. Two seeds
  // agreeing in direction, on the mode with five times V3's sample, is. The
  // direction is what the re-pricing implies: Total War has two win
  // conditions and the evaluation now states the territory one far more
  // weakly, so a given score predicts the result less sharply and the same
  // confidence needs more centipawns.
  V5: 0.003_236, // Total War, 75% at 340 centipawns
  V3: 0.004_949, // Infiltration, 75% at 222 centipawns
});

/**
 * Modes the engine will search that nobody has fitted a scale for yet.
 *
 * Being on this list is not a configuration choice — it is an admission, and
 * `gameReview.test.mts` requires that every mode in `ENGINE_MODE_CODES` is
 * either fitted above or named here. The point is that the fallback below is
 * otherwise *silent*: a mode added to the engine starts converting its
 * evaluations through some other mode's logistic, every grade and accuracy on
 * the screen is downstream of that conversion, and nothing anywhere says so.
 *
 * That is exactly what happened to Intransitive. It was added to
 * `ENGINE_MODE_CODES`, the review started grading it, and it spent that whole
 * time borrowing Infiltration's curve — while being the mode nearly every game
 * on the site is now played in. A borrowed scale is not a small error either:
 * it is the number that decides how many points of expected score a centipawn
 * is worth, so getting it wrong tilts every badge in the same direction at
 * once.
 *
 * Remove an entry by running the fit, not by deleting the line — but read
 * `docs/review.md` under "Intransitive cannot be fitted by self-play" first.
 * For Intransitive the existing script cannot do it at all: the engine draws
 * 145 of 150 games against itself in that mode and never builds an advantage
 * past two pawns, so there is nothing for a logistic to predict and the fit
 * pins at its own lower bound. That mode needs fitting from archived games,
 * which have real results in them.
 */
export const UNCALIBRATED_MODES: ReadonlySet<string> = new Set(['V6']);

// A mode nobody has calibrated yet borrows a measured scale rather than a
// guess of its own — Infiltration's, which is the sharper of the two fitted
// modes and is therefore the more conservative thing to borrow only for a
// mode that turns out to be quieter than it. Whether that is so is not
// knowable in advance, which is the whole reason `UNCALIBRATED_MODES` exists:
// this is a placeholder to be removed by measurement, not a default to settle
// for.
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
 * Lichess's accuracy curve. Exactly the published constants, named so that the
 * bands below can be derived from the same three numbers the curve uses rather
 * than from a second copy of them.
 */
const ACCURACY_CURVE = Object.freeze({ scale: 103.1668, decay: 0.043_54, offset: 3.166_9 });

/**
 * Lichess's accuracy curve, applied to expected-score points lost.
 *
 * The curve's job is to turn "you gave away eight points of expected score"
 * into a number a human reads as a school grade, and that job does not depend
 * on which game produced the eight points.
 */
export const accuracyForLoss = (lossPercent: number) => {
  const lost = Math.max(0, lossPercent);
  const raw =
    ACCURACY_CURVE.scale * Math.exp(-ACCURACY_CURVE.decay * lost) - ACCURACY_CURVE.offset;
  return Math.max(0, Math.min(100, raw));
};

export const moveAccuracy = (winPercentBefore: number, winPercentAfter: number) =>
  accuracyForLoss(winPercentBefore - winPercentAfter);

/**
 * The loss that scores a given accuracy — the curve above, read backwards.
 *
 * This is where the grade bands come from, so it is computed rather than
 * tabulated: a boundary and the accuracy it corresponds to cannot drift apart
 * if only one of them exists.
 */
export const lossForAccuracy = (accuracy: number) =>
  -Math.log((accuracy + ACCURACY_CURVE.offset) / ACCURACY_CURVE.scale) / ACCURACY_CURVE.decay;

/**
 * A loss, written to the precision the engine can actually support.
 *
 * "10.1 points of expected score given up" reads as a measurement to a tenth
 * of a point. It is not one. `scripts/reviewStability.mts` grades the same
 * games at every rung of the shipped ladder and compares each move's loss
 * against the deepest opinion available: the shallowest rung a reviewer can
 * see disagrees with it by more than two points on one move in ten, and even
 * the Deep rung by more than one. The tenths were never information, and
 * printing them invites a reader to compare two moves that the engine cannot
 * separate.
 *
 * Whole points, then, and "under a point" rather than "0.4" — because the
 * interesting thing about 0.4 is that it is nothing, not that it is 0.4.
 */
export const formatLoss = (lossPercent: number) => {
  if (!Number.isFinite(lossPercent) || lossPercent < 1) return 'under a point';
  return `${Math.round(lossPercent)} points`;
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

/**
 * How far RPSFish typically disagrees with itself about one move, in
 * expected-score points.
 *
 * Measured by `scripts/reviewStability.mts`: it plays games, grades each one at
 * every rung of the shipped ladder, and compares every move's loss against the
 * deepest opinion the engine has. This is the *third quartile* of that
 * disagreement at the shallowest rung a reviewer can be shown — shallowest
 * because which rung a reader gets is decided by `analysisBudget.ts` from their
 * device and not by them, and the third quartile because of what the rest of
 * the distribution looks like.
 *
 * Measured over 521 positions of Infiltration: median 1.7, p75 4.8, p90 8.5,
 * p95 11.5. Total War is quieter by a factor of four at every quantile, which
 * is what the steeper win-probability scale for Infiltration implies, so the
 * figure here is Infiltration's — the bands are shared, so they have to hold
 * for the noisier mode.
 *
 * **The tail is not a band width anybody can build with.** No scheme with five
 * classes can put twelve points between every boundary and still call a
 * twelve-point loss anything but excellent. So this is the number the
 * *descriptive* bands have to clear, and the tail is the reason the two
 * *accusing* ones — Mistake and Blunder — start four and seven times further
 * out than it, rather than just past it.
 *
 * Either way it is a floor on the real uncertainty rather than an estimate of
 * it, because it only measures the engine disagreeing with a deeper version of
 * itself. The larger error cannot be measured from in here: RPSFish is weaker
 * than most of the bots on this site, so the move it names as best is
 * sometimes not the best move, and a loss measured against a wrong baseline is
 * wrong by however much the baseline was.
 */
export const ENGINE_LOSS_ERROR_BAR = 5;

/**
 * The same disagreement at the 95th percentile, rounded up: the tail.
 *
 * Kept separate from the figure above because it is used for a different job.
 * No five-class scheme can be built out of twelve-point bands, so this is not
 * a band width — it is the distance a badge has to be from the boundary below
 * it before the badge is worth *accusing* somebody with. Mistake starts at 20
 * and Blunder at 34, so both clear it with room, and `gameReview.test.mts`
 * requires that they keep doing so.
 */
export const ENGINE_LOSS_ERROR_TAIL = 12;

/**
 * The accuracy each band ends at: one fifth of the scale per grade.
 *
 * The bands are not chosen. They are the quintiles of the accuracy curve this
 * review already scores every move on, read backwards through
 * `lossForAccuracy`, so a grade means something a reader can state without
 * looking anything up: **Excellent scored 80% or better, Good 60 to 80,
 * Inaccuracy 40 to 60, Mistake 20 to 40, and a Blunder scored under 20.**
 *
 * They used to be 2 / 5 / 10 / 20 points of loss, which on this same curve is
 * 91 / 80 / 64 / 40 percent — three of the five bands crowded into the top
 * third of the scale, and the first boundary drawn at a loss of 2. Three
 * quarters of the moves in a measured game lose less than that, so the badge
 * on most of a game was being decided inside the engine's own margin of
 * error; `scripts/reviewStability.mts` found a quarter of all badges changing
 * class between the shallowest rung of the ladder and the deepest, and one in
 * nine even between Deep and the rung above it, while the loss *numbers* those
 * badges came from barely moved. Narrow bands in the wrong place, not a noisy
 * engine.
 *
 * The quintiles fix that on their own, and they turn out to clear
 * `ENGINE_LOSS_ERROR_BAR` at every boundary as well — which
 * `gameReview.test.mts` checks rather than assumes, since the two were derived
 * independently and only one of them is a measurement.
 *
 * None of this touches an accuracy figure. Accuracy is the curve applied to
 * the loss; these are cut points on the same curve, and a cut point is not an
 * input to the number being cut. What changed is which word is printed over a
 * move.
 */
const BAND_ACCURACIES = Object.freeze({
  excellent: 80,
  good: 60,
  inaccuracy: 40,
  mistake: 20,
});

/** The loss a band ends at, in whole points: nothing here reads a tenth. */
const bandCeiling = (accuracy: number) => Math.round(lossForAccuracy(accuracy));

export const MOVE_GRADES: readonly MoveGrade[] = Object.freeze([
  { key: 'best', label: 'Best', symbol: '★', maxLoss: 0 },
  { key: 'great', label: 'Great', symbol: '!', maxLoss: 0 },
  {
    key: 'excellent',
    label: 'Excellent',
    symbol: '✓',
    maxLoss: bandCeiling(BAND_ACCURACIES.excellent),
  },
  { key: 'good', label: 'Good', symbol: '.', maxLoss: bandCeiling(BAND_ACCURACIES.good) },
  {
    key: 'inaccuracy',
    label: 'Inaccuracy',
    symbol: '?!',
    maxLoss: bandCeiling(BAND_ACCURACIES.inaccuracy),
  },
  {
    key: 'mistake',
    label: 'Mistake',
    symbol: '?',
    maxLoss: bandCeiling(BAND_ACCURACIES.mistake),
  },
  { key: 'blunder', label: 'Blunder', symbol: '??', maxLoss: Infinity },
] satisfies readonly MoveGrade[]);

const gradeByKey = (key: GradeKey): MoveGrade => {
  const grade = MOVE_GRADES.find((candidate) => candidate.key === key);
  if (!grade) throw new Error(`${key} is not a move grade.`);
  return grade;
};

const BEST_GRADE = gradeByKey('best');
const GREAT_GRADE = gradeByKey('great');
const LOSS_GRADES = MOVE_GRADES.filter((grade) => grade.key !== 'best' && grade.key !== 'great');
const WORST_GRADE = LOSS_GRADES[LOSS_GRADES.length - 1] ?? gradeByKey('blunder');

/**
 * How much the second line has to give up before the first one earns `!`.
 *
 * Keyed to the Inaccuracy ceiling, so the claim `!` makes is "every other move
 * the engine could see was a mistake or worse" rather than the weaker "every
 * other move was less than Good".
 *
 * It was the latter, and that was too cheap for the strongest claim on the
 * badge list. `!` rests on more of the engine's opinion than any other grade:
 * not just on the score of the move played, but on the score of a move nobody
 * played *and* on MultiPV having ordered the alternatives correctly at this
 * depth. `scripts/reviewStability.mts` measures how far that trust goes — the
 * engine's own first line changes between the shallowest rung and the deepest
 * on one position in eight, and line two is a weaker opinion than line one. So
 * the margin has to be wide enough that the ordering being slightly wrong does
 * not matter.
 */
const ONLY_GOOD_MOVE_MARGIN = gradeByKey('inaccuracy').maxLoss;

/**
 * Whether the engine's first line was the only move it thinks is playable.
 *
 * MultiPV is ordered, so if line two gives up more than the margin, every
 * later legal move does too. That makes this a measurable version of the
 * conventional Chess.com-style Great Move rather than a decorative `!`.
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
  return lossPercent > ONLY_GOOD_MOVE_MARGIN;
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

/**
 * The opening a stand-in definition carries, for the modes that do not share
 * the block above.
 *
 * Only Intransitive needs an entry, and it needs one for a narrower reason than
 * it looks: every archived record carries its own `FEN`, so the board a review
 * replays from never comes from here. What does come from here is the opening
 * `eraOf` measures a record against, and measuring a V6 record against V3's
 * blocks would answer "not the pre-change opening" for every game in the mode.
 */
const MODE_FALLBACK_LAYOUTS: Record<string, string[]> = {
  V6: [
    '.........', '...RP....', '..RPS....',
    '.RPS.....', '.PS...sp.', '.....spr.',
    '....spr..', '....pr...', '.........',
  ],
};

/**
 * The rules a stand-in definition has to carry, because they are what the
 * replay below adjudicates on. The same answers the server's mode registry
 * gives; only the ones that change the outcome of a position are listed, so a
 * mode not named here replays under the standard rules.
 */
const MODE_FALLBACK_FEATURES: Record<string, ModeFeature[]> = {
  V5: ['territory'],
  V6: ['stalemate_loses'],
};

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
    features: MODE_FALLBACK_FEATURES[modeId] ?? [],
    startingPosition: { rows: MODE_FALLBACK_LAYOUTS[modeId] ?? MODE_FALLBACK_ROWS },
  };
};

/**
 * Reverse the ranks and swap the colours: `RankFlip` in `game/rank_flip.go`,
 * spelled on layout rows because that is the shape both sides of the
 * comparison below are already in.
 *
 * Files are left alone. This is an end-for-end flip, not a rotation — the
 * distinction that matters, because the half turn is a symmetry of today's
 * rules and would carry V6's opening onto itself instead of onto yesterday's.
 */
const rankFlipRows = (rows: string[]): string[] =>
  [...rows]
    .reverse()
    .map((row) =>
      row.replace(/[a-zA-Z]/g, (letter) =>
        letter === letter.toUpperCase() ? letter.toLowerCase() : letter.toUpperCase(),
      ),
    );

/**
 * Which rules a record was played under, read off the record itself.
 *
 * The evidence is the board it declares, not its date and not a version tag:
 * a `FEN` that rank-flips onto exactly this mode's opening, side to move
 * included, is yesterday's opening position and nothing else is. That is the
 * same test the backend applies before it will relabel an archived game —
 * `isStandardStartingPosition` in `opening_stats.go` — and it is deliberately
 * strict. A position somebody drew and handed to Red is also a game that opens
 * with Red to move, and it is *not* a pre-change game; judging it by yesterday's
 * corners would break a record that reads correctly today.
 *
 * Records that started from a board somebody drew therefore read as `current`
 * whichever era they came from. There is no evidence either way in such a
 * record, and today's rules are the answer that needs no assumption.
 */
const eraOf = (
  mode: ModeDefinition,
  grid: Grid,
  currentTurn: PlayerColor,
): RulesEra => {
  if (currentTurn === FIRST_TO_MOVE || currentTurn === 'Neutral') return 'current';
  const opening = mode.startingPosition?.rows;
  if (!opening || opening.length !== grid.length) return 'current';
  const flipped = rankFlipRows(startingPositionFromGrid(grid).rows);
  return flipped.join('/') === opening.join('/') ? 'preChange' : 'current';
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
  /** What they were rated going into the game, when the record says. */
  elo: number | null;
  /** And coming out of it, for a game that moved a rating. */
  eloAfter: number | null;
}

/**
 * A record, replayed: the line of positions, the moves that made it, and
 * everything the tags say about the game around it.
 */
export interface ReviewSource {
  mode: ModeDefinition;
  /**
   * Which rules this record was played under. `preChange` for a game from
   * before the 2026-09-03 board flip, which is where its goal squares are —
   * the board draws them from here so that a tile tinted as a goal is the tile
   * the replay ends the game on. See `./goals`.
   */
  era: RulesEra;
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
  /**
   * Which scale this record's ratings are written on, straight off the tag, or
   * `null` for a record archived before there were two of them.
   *
   * Read rather than assumed, and worth carrying for the same reason `era` is.
   * The old scale was chess Elo centred on 1200 and today's starts at 1 — both
   * produce numbers that look like ratings, nothing else in the file says which
   * is which, and the two cannot be compared. What this string is *worth* is
   * `features/ratings/scale`'s to say; a replayed record's job is only to
   * report what was written down.
   */
  ratingSystem: string | null;
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
        return createAnalysisGameFrom(mode, grid, currentTurn, eraOf(mode, grid, currentTurn));
      })()
    : createAnalysisGameFrom(mode, decodePosition(MODE_FALLBACK_ROWS.join('/')).grid);

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
    era: start.era,
    positions,
    moves,
    gameId: parsed.tag('GameId'),
    event: parsed.tag('Event'),
    // Opening moves that were dealt rather than chosen. A bot series deals
    // each pair an opening out of the published book, and grading those as
    // though somebody picked them would misreport both engines' accuracy.
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
    ratingSystem: parsed.tag('RatingSystem') || null,
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
 * series deals each pair an opening out of the published book, recorded in the
 * PGN's BookPlies tag. Those moves are still graded, because the evaluation curve
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
