// One way to have RPSFish grade a game, for every screen that grades one.
//
// The review screen, the bot battle, and the analysis board all want the same
// thing: an evaluation for every position of a line, a grade for every move in
// it, and an accuracy per side. They differ only in where the line comes from.
// A finished record arrives whole. A battle arrives one move at a time while
// the analysis is still catching up. An analysis board grows *and* shrinks, as
// moves are played, taken back, and replaced.
//
// A session here absorbs all three. Hand it the line as it currently stands,
// as often as it changes; it keeps the engine walking the part it has not
// graded yet, and re-grades only from the point where the line stopped being
// the line it already knows.
//
// Two rules it exists to enforce, both from `docs/review.md`:
//
//   1. Every grade comes from the review walk, never from a search that was
//      run for some other purpose. A bot's own search is how that bot chose
//      its move — it is shallow on purpose, and it is a different search per
//      side — so grading a battle with it would measure the bots against
//      themselves and call the result an evaluation.
//   2. A move's loss is read off one search of one position. The walk does
//      that with a paired root-restricted search when it has to; nothing here
//      subtracts scores that came from different searches.

import { enginePosition, type PositionLike } from './analysisGame';
import { REVIEW_PRESETS, reviewGame, type ReviewFn } from './rpsfish/client';
import type { ReviewEntry, SearchLimits } from './rpsfish/protocol';
import type { Move } from '@/types/game';

const SIGNATURE_PIECES: Record<string, Record<string, string>> = {
  Blue: { Rock: 'R', Paper: 'P', Scissors: 'S' },
  Red: { Rock: 'r', Paper: 'p', Scissors: 's' },
};
const SIGNATURE_TERRITORY: Record<string, string> = { Red: '+', Blue: '-' };

const signatureCache = new WeakMap<PositionLike, string>();

/**
 * A string that differs whenever two positions do.
 *
 * This is how a session tells "the game gained a move" from "this is no longer
 * the game I was grading": an undo, a different branch, a new battle. Positions
 * are immutable once built, so each one is encoded at most once.
 */
export const positionSignature = (game: PositionLike): string => {
  const cached = signatureCache.get(game);
  if (cached !== undefined) return cached;
  let signature = `${game.mode?.id}|${game.currentTurn}|${game.moveNumber}`;
  for (const row of game.grid) {
    for (const tile of row) {
      signature += SIGNATURE_PIECES[tile.occupantOwner]?.[tile.occupant] ?? '.';
      signature += SIGNATURE_TERRITORY[tile.ownerColor] ?? '';
    }
  }
  signatureCache.set(game, signature);
  return signature;
};

/**
 * The first index at which two lines of play stop agreeing.
 *
 * Equal to the shorter length when one line is a prefix of the other, which is
 * the append-only case a live game produces.
 */
export const firstDivergence = (left: readonly string[], right: readonly string[]) => {
  const shared = Math.min(left.length, right.length);
  for (let index = 0; index < shared; index += 1) {
    if (left[index] !== right[index]) return index;
  }
  return shared;
};

/**
 * How far a walk has got.
 *
 * `waiting` means it has caught up with a game that is still being played, and
 * is the difference between "nothing left to grade" and "finished".
 *
 * `deepening` means every move on screen has a grade and the walk is regrading
 * the whole line at a deeper budget to see whether those grades were right. The
 * report stays on screen and stays readable throughout; it is replaced whole if
 * and when the deeper pass finishes.
 */
export type AnalysisStatus = 'idle' | 'running' | 'deepening' | 'waiting' | 'done' | 'error';

/** A deeper pass in flight, and how much of the line it has regraded. */
export interface RefinePass {
  done: number;
  limits: SearchLimits;
  total: number;
}

export interface AnalysisSnapshot {
  entries: ReviewEntry[];
  error: string | null;
  status: AnalysisStatus;
  /**
   * The budget every published entry was graded at.
   *
   * One budget for the whole report, always. Two moves graded at two depths
   * are two numbers that were never comparable, so a deeper pass replaces the
   * report whole or not at all — see `refining`.
   */
  limits: SearchLimits;
  /** Which rung of the ladder that budget is, counted from the shallowest. */
  pass: number;
  /** Whether the walk still means to try a deeper pass after this one. */
  deeperToCome: boolean;
  /** The deeper pass in flight, or `null` when nothing is being regraded. */
  refining: RefinePass | null;
}

/** A line of play as it currently stands. */
export interface GameLine {
  positions: PositionLike[];
  moves: Move[];
  /** Whether more positions are still expected. */
  streaming: boolean;
}

export interface GameAnalysisSession {
  submit: (line: Partial<GameLine>) => void;
  stop: () => void;
  snapshot: () => AnalysisSnapshot;
}

export interface CreateGameAnalysisOptions {
  /**
   * Wall clock the walk may spend deepening, every pass together, measured
   * from the last time the line changed. Zero grades once and stops.
   *
   * Not a limit on how long the walk may take: the first pass always runs to
   * completion, because a report with no grades in it is not a report.
   */
  budgetMs?: number;
  /**
   * The budgets to climb, weakest first. One rung is a walk that never
   * deepens.
   */
  ladder?: readonly SearchLimits[];
  /** Injectable clock, so a test need not spend the budget in real time. */
  now?: () => number;
  onChange?: (snapshot: AnalysisSnapshot) => void;
  /**
   * A single fixed budget, by name, as an alternative to `ladder`.
   *
   * For tests and measurement scripts, which want one known depth rather than
   * whatever the device could reach. Deliberately wider than the presets' own
   * union: a script supplies a `presets` map of its own and names a budget no
   * screen has ever offered.
   */
  preset?: string;
  presets?: Record<string, SearchLimits>;
  review?: ReviewFn;
  /**
   * How long a caught-up walk waits before starting a deeper pass.
   *
   * Deepening a line that is still arriving only throws the work away, so the
   * walk waits for the line to hold still first. On a game being watched move
   * by move this never elapses, which is the intent.
   */
  settleMs?: number;
}

/**
 * A running analysis of one line of play.
 *
 * `submit({ positions, moves, streaming })` states the line as it now stands
 * and returns immediately; the walk continues in the background and `onChange`
 * fires as entries arrive. `streaming` says whether more positions are still
 * expected, which is the difference between "caught up" and "finished".
 *
 * ## Depth is chosen, not asked
 *
 * The walk climbs `ladder`. The shallowest rung runs first, so grades reach the
 * screen in a second or two; once every move has one and the line has held
 * still for `settleMs`, the walk regrades the entire line at the next rung and
 * swaps the deeper report in when it completes. It keeps climbing until the
 * ladder runs out or the clock says the next pass will not fit in `budgetMs`.
 *
 * Whether the next pass will fit is measured, not assumed: each completed pass
 * is timed, and the estimate for the next one scales that measurement by the
 * ratio of the two rungs' time ceilings. A machine that turns out to be fast
 * climbs further than one that does not, without either of them being asked
 * what they are. If the estimate is wrong and a pass overruns the budget, it is
 * abandoned and the report it would have replaced stays — an overrun costs
 * background time, never a grade.
 *
 * A deeper pass never publishes a partial result. Rule 2 of `docs/review.md`
 * is that a move's loss is read off one search of one position; the report-wide
 * corollary is that every move in one report must come off the same budget, or
 * the accuracy computed across them is comparing numbers from two searches. So
 * the pass accumulates out of sight and replaces the report atomically, and
 * `refining` is how a screen says a better answer is on its way.
 *
 * `review` and `presets` are injectable so this can be driven by the Node
 * worker shim in a test rather than by a browser worker.
 */
export const createGameAnalysis = ({
  budgetMs = 0,
  ladder,
  now = () => Date.now(),
  onChange,
  preset,
  presets = REVIEW_PRESETS,
  review = reviewGame,
  settleMs = 1_200,
}: CreateGameAnalysisOptions = {}): GameAnalysisSession => {
  // A named preset is one rung and no climbing, which is what a measurement
  // wants: a number it can attribute to a depth it chose.
  const rungs: readonly SearchLimits[] =
    ladder && ladder.length > 0
      ? ladder
      : [(preset === undefined ? undefined : presets[preset]) ?? REVIEW_PRESETS.standard];

  let entries: ReviewEntry[] = [];
  let signatures: string[] = [];
  let line: GameLine = { positions: [], moves: [], streaming: false };
  let status: AnalysisStatus = 'idle';
  let error: string | null = null;
  let busy = false;
  // Bumped whenever the line stops being the one an in-flight request was
  // asked about, so entries from that request can be recognised as stale
  // rather than dropped into the wrong place.
  let generation = 0;
  let stopped = false;

  /** Which rung of the ladder the published entries were graded at. */
  let rung = 0;
  /** The pass in flight, when it is a deeper one, and what it has produced. */
  let refining: RefinePass | null = null;
  let refined: ReviewEntry[] = [];
  /** Set once the ladder is done with: no rung left, or no clock left. */
  let spent = false;

  // The clock the budget is measured against. Restarted whenever the line
  // changes, because the reviewer's patience starts again when the thing being
  // reviewed does — and because on an analysis board the line changes every
  // time a move is played.
  let climbStartedAt: number | null = null;
  let passStartedAt = 0;
  let lastPassMs: number | null = null;
  /** How many positions the last timed pass actually graded. */
  let lastPassGraded = 0;

  let active: AbortController | null = null;
  let settleTimer: ReturnType<typeof setTimeout> | null = null;
  let budgetTimer: ReturnType<typeof setTimeout> | null = null;

  const clearSettleTimer = () => {
    if (settleTimer === null) return;
    clearTimeout(settleTimer);
    settleTimer = null;
  };
  const clearBudgetTimer = () => {
    if (budgetTimer === null) return;
    clearTimeout(budgetTimer);
    budgetTimer = null;
  };

  // Only when something moved. A caller that rebuilds its `positions` array
  // every render submits an unchanged line often, and answering each of those
  // with a fresh snapshot would drive a render loop. Deepening progress counts
  // as movement: it is the one thing that changes while the report does not.
  let published: AnalysisSnapshot | null = null;
  const publish = () => {
    const limits = rungs[rung] ?? REVIEW_PRESETS.standard;
    const deeperToCome = !spent && rung + 1 < rungs.length;
    if (
      published &&
      published.entries === entries &&
      published.error === error &&
      published.status === status &&
      published.limits === limits &&
      published.deeperToCome === deeperToCome &&
      published.refining?.done === refining?.done &&
      published.refining?.total === refining?.total &&
      published.refining?.limits === refining?.limits
    ) {
      return;
    }
    published = { deeperToCome, entries, error, limits, pass: rung, refining, status };
    onChange?.(published);
  };

  /**
   * How far into the line the walk can usefully get right now.
   *
   * One short of the end while more moves are still coming. The last position
   * of a game in progress has no move out of it yet, and a position graded
   * before its move exists yields an entry that carries an evaluation but can
   * never carry a grade — so the move eventually played from it would read as
   * ungraded for the rest of the game. It is graded when its move arrives, or
   * when the game ends and it is genuinely the last position.
   */
  const frontier = () =>
    line.streaming
      ? Math.min(line.positions.length, line.moves.length)
      : line.positions.length;

  const settle = () => {
    if (error) status = 'error';
    else if (refining) status = 'deepening';
    else if (entries.length < frontier()) status = 'running';
    else status = line.streaming ? 'waiting' : 'done';
  };

  /**
   * Whether the next rung is worth starting.
   *
   * The estimate is the last pass's measured cost per position, scaled up to
   * the whole line and then by how much more time per position the next rung
   * allows. That last ratio is the pessimistic reading — most searches finish
   * on depth rather than on their time ceiling — which is the right direction
   * to be wrong in: overestimating costs a rung the device could have managed,
   * underestimating costs a pass that gets abandoned for overrunning.
   */
  const worthDeepening = () => {
    if (spent || stopped) return false;
    const next = rungs[rung + 1];
    const current = rungs[rung];
    if (!next || !current) return false;
    // Nothing has been timed yet, so there is nothing to project from. Not the
    // same as "cannot afford it" — see `advance`, which is careful not to
    // confuse the two.
    if (entries.length === 0 || lastPassMs === null || climbStartedAt === null) return false;
    const perPosition = lastPassMs / Math.max(1, lastPassGraded);
    const ratio = Math.max(1, next.maxTimeMs / current.maxTimeMs);
    const projected = perPosition * entries.length * ratio;
    return now() - climbStartedAt + projected <= budgetMs;
  };

  /** Whether there is a rung left and a timed pass to judge it against. */
  const measured = () =>
    rung + 1 < rungs.length && entries.length > 0 && lastPassMs !== null;

  const request = (deepening: boolean) => {
    const requestGeneration = generation;
    const target = deepening ? rung + 1 : rung;
    const limits = rungs[target];
    if (!limits) {
      settle();
      publish();
      return;
    }
    const analyzeFrom = deepening ? 0 : entries.length;
    const end = frontier();
    const { moves, positions } = line;
    const controller = new AbortController();
    active = controller;
    busy = true;
    passStartedAt = now();
    climbStartedAt ??= passStartedAt;
    // Cleared now rather than on success, so an entry arriving from this
    // attempt cannot be settled back into the failure that preceded it.
    error = null;
    if (deepening) {
      refined = [];
      refining = { done: 0, limits, total: end };
      // The guarantee behind the budget. The projection above says the pass
      // should fit; this is what happens when it was wrong.
      clearBudgetTimer();
      budgetTimer = setTimeout(
        () => {
          budgetTimer = null;
          spent = true;
          controller.abort();
        },
        Math.max(0, budgetMs - (now() - (climbStartedAt ?? passStartedAt))),
      );
    }
    settle();
    publish();

    review(
      {
        analyzeFrom,
        moves: moves.slice(0, end).map(({ from, to }) => ({ from, to })),
        positions: positions.slice(0, end).map(enginePosition),
      },
      { ...limits, signal: controller.signal },
      (entry) => {
        // The walk grades in order from `analyzeFrom`, so an entry that is not
        // the next one belongs to a line this session has already moved off.
        if (stopped || requestGeneration !== generation) return;
        if (deepening) {
          if (entry.index !== refined.length) return;
          refined = [...refined, entry];
          refining = { done: refined.length, limits, total: end };
          publish();
          return;
        }
        if (entry.index !== entries.length) return;
        entries = [...entries, entry];
        settle();
        publish();
      },
    )
      .then(() => {
        const elapsed = now() - passStartedAt;
        busy = false;
        active = null;
        clearBudgetTimer();
        if (stopped) return;
        if (requestGeneration !== generation) {
          refined = [];
          refining = null;
          advance();
          return;
        }
        if (deepening) {
          // A pass that did not regrade the whole line was asked about a line
          // that changed under it. Only a complete one may replace the report.
          if (refined.length === entries.length) {
            entries = refined;
            rung = target;
            lastPassMs = elapsed;
            lastPassGraded = refined.length;
          }
          refined = [];
          refining = null;
        } else {
          lastPassMs = elapsed;
          lastPassGraded = Math.max(1, entries.length - analyzeFrom);
        }
        advance();
      })
      .catch((failure: unknown) => {
        busy = false;
        active = null;
        clearBudgetTimer();
        const named = failure as { name?: string; message?: string } | null;
        if (stopped) return;
        // A pass abandoned because the line changed under it, or because it ran
        // past the budget, is not a failure. The report it was going to replace
        // is still the report, and still correct.
        if (named?.name === 'AbortError' || requestGeneration !== generation) {
          refined = [];
          refining = null;
          advance();
          return;
        }
        refined = [];
        refining = null;
        // A real failure is reported rather than retried on the spot. The next
        // submission tries again, so a game still being played recovers on its
        // own next move instead of spinning here.
        error = named?.message ?? 'RPSFish could not grade this game.';
        status = 'error';
        publish();
      });
  };

  // Either keep walking, line up a deeper pass, or say where the walk has got
  // to. Called after every change to the line and after every request settles,
  // so those are the only two things that can move a session.
  const advance = () => {
    if (stopped) return;
    if (busy) {
      settle();
      publish();
      return;
    }
    if (entries.length < frontier()) {
      clearSettleTimer();
      request(false);
      return;
    }
    // Caught up. A deeper pass is worth starting only once the line has held
    // still, so a game arriving move by move is never regraded mid-instalment.
    if (settleTimer === null && !spent) {
      if (worthDeepening()) {
        settleTimer = setTimeout(() => {
          settleTimer = null;
          if (stopped || busy) return;
          if (entries.length < frontier()) {
            advance();
            return;
          }
          // Asked again on the way in, because the clock has moved since the
          // timer was armed and the line may have grown and been graded.
          if (!worthDeepening()) {
            spent = true;
            settle();
            publish();
            return;
          }
          request(true);
        }, settleMs);
      } else if (measured()) {
        // A rung left, a timed pass to judge it by, and the judgement is no.
        // Recorded, because otherwise the walk would go on claiming a deeper
        // pass was coming for as long as the screen was open. Deliberately not
        // reached when there is nothing to judge by yet: a game that has only
        // just stopped arriving has not been offered a deeper pass at all.
        spent = true;
      }
    }
    settle();
    publish();
  };

  return {
    submit({ moves = [], positions = [], streaming = false }) {
      if (stopped) return;
      const nextSignatures = positions.map(positionSignature);
      const divergence = firstDivergence(signatures, nextSignatures);
      const moved =
        divergence < signatures.length ||
        divergence < nextSignatures.length ||
        line.streaming !== streaming;
      signatures = nextSignatures;
      line = { moves, positions, streaming };
      // Everything from the first changed position onwards was graded for a
      // game that is no longer this one. Bumping the generation is what makes
      // a request that is already in flight for those positions stale rather
      // than wrong, and aborting it stops the engine working on the answer to
      // a question nobody is asking any more.
      if (divergence < entries.length) {
        entries = entries.slice(0, divergence);
        error = null;
        generation += 1;
        active?.abort();
      }
      if (moved) {
        // The budget is the wait since the line last changed, so the clock
        // restarts with the line. On an analysis board that is every move; the
        // alternative would mean a session left open for a minute could never
        // deepen anything again.
        clearSettleTimer();
        climbStartedAt = now();
        spent = false;
      }
      advance();
    },
    stop() {
      stopped = true;
      clearSettleTimer();
      clearBudgetTimer();
      active?.abort();
    },
    snapshot() {
      return {
        deeperToCome: !spent && rung + 1 < rungs.length,
        entries,
        error,
        limits: rungs[rung] ?? REVIEW_PRESETS.standard,
        pass: rung,
        refining,
        status,
      };
    },
  };
};
