// A player that does nothing but race, block, and count moves.
//
// `reach.ts` answers one question: how long is the shortest run to the goal row
// that nothing can cut off, for one piece. Infiltration is won by exactly that,
// so a move can be graded without an evaluation function at all — play it, ask
// the same question of both sides from the position it leaves behind, and prefer
// the move whose surviving run is shorter than the opponent's. One ply, a
// handful of breadth-first walks, and a comparison. No search tree, no material
// term, no positional score.
//
// The four things it does not know, stated up front, because a greedy player
// believes its own model and this one is optimistic in the direction that loses
// games:
//
//   1. **A reading is a bound, not a proof.** Every walk holds the other
//      seventeen pieces still for the whole length of a run. `docs/reach.md`
//      says so about the study tool and it is no truer here.
//   2. **Interception is not only capture.** An enemy piece that merely stands
//      in the corridor stops a runner without taking it, and `reach.ts` counts
//      only predators. So every piece is read twice — `safeDistance` is the
//      study tool's number, `clearDistance` also treats the enemy pieces of the
//      runner's *own* kind as interceptors, since those are the ones that can
//      neither be captured nor walked through. `RPSFish/BREAKAWAY.md`
//      §"Risks" names this gap and this is its fix.
//   3. **Tempo is assumed free.** A runner is credited with spending every move
//      running. If it has to answer something elsewhere, the run is slower.
//   4. **One ply sees no exchange.** A race reading prices a piece by what it
//      can reach, never by what it is worth, so nothing in it objects to leaving
//      a piece where it will simply be taken — and losing the last predator of a
//      kind hands the opponent an uncatchable runner. `answerCaptures` buys that
//      back for the price of one reply-deep look at captures only, which is the
//      cheapest thing that stops the greedy player from feeding its army away.
//
// Infiltration only, and it says so: `supportsReachRace` is the same gate the
// study tool uses, and a mode with no goal row to race to has nothing here.

import {
  allValidMoves,
  applyAnalysisMove,
  type AnalysisGame,
  type PositionLike,
} from './analysisGame';
import {
  UNREACHABLE,
  goalRowFor,
  mergeMaps,
  reachMap,
  safeRun,
  supportsReachRace,
  threatMap,
  walkersOn,
  type DistanceMap,
  type ObstacleModel,
  type RunOptions,
  type SafeRun,
  type Walker,
} from './reach';
import type { Analysis, EngineLine } from './rpsfish/protocol';
import {
  opposingColor,
  type Grid,
  type Move,
  type SideColor,
} from '@/types/game';

/** What the racer is allowed to assume while it reads a position. */
export interface RacerOptions {
  /**
   * What blocks a walk. `static` is the honest one and the default: a piece
   * standing in front of your own runner really is in the way, and a move that
   * steps out of it really does shorten the run. `friendlyVacates` credits your
   * own pieces with stepping aside for free, which is a tempo the run does not
   * have.
   */
  obstacles: ObstacleModel;
  /**
   * Look one reply deep at the opponent's captures and take the worst of them.
   * Off, the racer will walk a piece onto a square where it is simply taken,
   * because nothing in a race reading prices a piece it is about to lose.
   */
  answerCaptures: boolean;
}

export const RACER_DEFAULTS: RacerOptions = Object.freeze({
  obstacles: 'static',
  answerCaptures: true,
});

/**
 * Every dial in one place, in a made-up unit that only has to be internally
 * consistent: nothing here is comparable to an RPSFish centipawn, and the only
 * number that has to line up with anything else is `win`, which sits above
 * `MATE_SCORE_FLOOR` in `bots/engine.ts` so a decided race reads as decided.
 *
 * The ordering is the whole design. A move that shortens a run nothing can
 * touch outranks one that shortens a run only a predator can cut off, which
 * outranks bare progress; and being the side with two surviving runners is worth
 * about two moves of the race, because an opponent with one interceptor cannot
 * be in two corridors at once.
 */
export const RACE_WEIGHTS = Object.freeze({
  /** Per move of the differential between the two sides' uncuttable runs. */
  clear: 120,
  /** Per move of the same differential read against predators only. */
  safe: 40,
  /** Per move of the differential in bare distance, ignoring interception. */
  progress: 8,
  /** Per surviving runner more than the opponent has. */
  runners: 15,
  /** Per earlier visit to the position a move walks back into. */
  repeat: 60,
  /** A decided game. */
  win: 30_000,
});

/**
 * The stand-in distance for "there is no run".
 *
 * Only its ordering matters — it has to be worse than any run a nine-by-nine
 * board can hold — but a finite number keeps every term a subtraction rather
 * than a case analysis.
 */
const NO_RUN = 16;

/** One side's whole race, as three distances and a count. */
export interface RaceReading {
  /** Moves to the goal row through the pieces as they stand, ignoring interception. */
  blockedDistance: number;
  /** Moves along the fastest run no predator can cut off, or `null`. */
  safeDistance: number | null;
  /** Moves along the fastest run no predator *and no blocker* can cut off, or `null`. */
  clearDistance: number | null;
  /** How many pieces have a run no predator can cut off. */
  safeRunners: number;
  /** The piece with the fastest surviving run, and the run itself. */
  best: Walker | null;
  bestRun: SafeRun | null;
}

const NO_RACE: RaceReading = Object.freeze({
  blockedDistance: UNREACHABLE,
  safeDistance: null,
  clearDistance: null,
  safeRunners: 0,
  best: null,
  bestRun: null,
});

/** Enemy pieces of a walker's own kind: they cannot take it, and it cannot take them. */
const twinsOf = (grid: Grid, walker: Walker): Walker[] => {
  const owner = opposingColor(walker.owner);
  const found: Walker[] = [];
  for (let y = 0; y < grid.length; y += 1) {
    const row = grid[y] ?? [];
    for (let x = 0; x < row.length; x += 1) {
      const tile = row[x];
      if (tile?.occupant === walker.piece && tile.occupantOwner === owner) {
        found.push({ from: { x, y }, piece: walker.piece, owner });
      }
    }
  }
  return found;
};

/** The two threat maps a kind is read against, built once per side and kind. */
interface Interception {
  /** Where a predator can be, and when. The study tool's threat map. */
  capture: DistanceMap;
  /** As `capture`, plus every square an enemy piece of this kind can stand on. */
  clear: DistanceMap;
}

/**
 * Threat maps keyed by side and kind.
 *
 * Every red rock is hunted by the same blue papers and blocked by the same blue
 * rocks, so at most six entries cover a whole board — the same sharing
 * `threatCache` does in `reach.ts`, extended to the blocking half. The cache is
 * per position, so a caller building one per candidate move is correct; it is
 * the walks inside one reading that are worth sharing, not the readings.
 */
const interceptionMaps = (grid: Grid, obstacles: ObstacleModel) => {
  const cache = new Map<string, Interception>();
  return (walker: Walker): Interception => {
    const key = `${walker.owner}:${walker.piece}`;
    const cached = cache.get(key);
    if (cached) return cached;
    const capture = threatMap(grid, walker, obstacles);
    const twins = twinsOf(grid, walker);
    const maps: Interception = {
      capture,
      clear:
        twins.length === 0
          ? capture
          : mergeMaps([capture, ...twins.map((twin) => reachMap(grid, twin, obstacles))]),
    };
    cache.set(key, maps);
    return maps;
  };
};

/**
 * One side's fastest surviving run, and how many it has.
 *
 * Three walks per piece at worst, and it bails out of the expensive ones early:
 * a piece with no route at all is not a runner, and a piece a predator can cut
 * off is not a candidate for the stricter reading either — `clear` is a subset
 * of `safe`, because adding interceptors can only shrink the squares a run may
 * use.
 */
export const readRace = (
  position: PositionLike,
  color: SideColor,
  options: RacerOptions = RACER_DEFAULTS,
  maps: (walker: Walker) => Interception = interceptionMaps(position.grid, options.obstacles),
): RaceReading => {
  const goalRow = goalRowFor(position.mode?.id, color);
  if (goalRow === null) return NO_RACE;

  const runOptions: RunOptions = {
    obstacles: options.obstacles,
    safety: 'off',
    // The tempo term of the safety test: a runner whose side does not move next
    // has given its hunters one more move by the time it arrives.
    walkerToMove: position.currentTurn === color,
    goalEndsGame: true,
  };

  const reading = { ...NO_RACE };
  for (const walker of walkersOn(position.grid)) {
    if (walker.owner !== color) continue;

    const route = safeRun(position.grid, walker, goalRow, runOptions);
    if (!route) continue;
    if (route.moves < reading.blockedDistance) reading.blockedDistance = route.moves;

    const threats = maps(walker);
    const safe = safeRun(
      position.grid,
      walker,
      goalRow,
      { ...runOptions, safety: 'perStep' },
      threats.capture,
    );
    if (!safe) continue;
    reading.safeRunners += 1;
    if (reading.safeDistance === null || safe.moves < reading.safeDistance) {
      reading.safeDistance = safe.moves;
      reading.best = walker;
      reading.bestRun = safe;
    }

    const clear =
      threats.clear === threats.capture
        ? safe
        : safeRun(
            position.grid,
            walker,
            goalRow,
            { ...runOptions, safety: 'perStep' },
            threats.clear,
          );
    if (clear && (reading.clearDistance === null || clear.moves < reading.clearDistance)) {
      reading.clearDistance = clear.moves;
    }
  }
  return reading;
};

const distanceValue = (distance: number | null) =>
  distance === null || !Number.isFinite(distance) ? NO_RUN : Math.min(distance, NO_RUN);

/**
 * How the position reads for `color`, in the racer's own units.
 *
 * Positive is better for `color`. Every term is a difference between the two
 * sides' readings of the same quantity, so an equal position scores zero and a
 * mirrored one scores the negative — which is what makes the number safe to
 * compare across moves.
 */
const scoreReadings = (
  position: PositionLike,
  color: SideColor,
  mine: RaceReading,
  theirs: RaceReading,
): number => {
  // A piece one legal step from its goal row wins on the spot, so whoever is to
  // move with `blockedDistance === 1` has already won. This is the one reading
  // here that is exact rather than a bound: `blockedDistance` is measured
  // through the pieces as they stand, and one step through them is a legal move.
  const theyMoveNext = position.currentTurn !== color;
  if (theyMoveNext && theirs.blockedDistance === 1) return -RACE_WEIGHTS.win + 1;
  if (!theyMoveNext && mine.blockedDistance === 1) return RACE_WEIGHTS.win - 1;

  return (
    RACE_WEIGHTS.clear *
      (distanceValue(theirs.clearDistance) - distanceValue(mine.clearDistance)) +
    RACE_WEIGHTS.safe * (distanceValue(theirs.safeDistance) - distanceValue(mine.safeDistance)) +
    RACE_WEIGHTS.progress *
      (distanceValue(theirs.blockedDistance) - distanceValue(mine.blockedDistance)) +
    RACE_WEIGHTS.runners * (mine.safeRunners - theirs.safeRunners)
  );
};

/** `scoreReadings`, for a caller holding a position rather than two readings. */
export const scoreRace = (
  position: PositionLike,
  color: SideColor,
  options: RacerOptions = RACER_DEFAULTS,
): number => {
  const maps = interceptionMaps(position.grid, options.obstacles);
  return scoreReadings(
    position,
    color,
    readRace(position, color, options, maps),
    readRace(position, opposingColor(color), options, maps),
  );
};

const decidedScore = (game: AnalysisGame, color: SideColor): number =>
  game.winner === color
    ? RACE_WEIGHTS.win
    : game.winner === opposingColor(color)
      ? -RACE_WEIGHTS.win
      : 0;

/** How often the position a move lands in has been reached before. */
const repeatsAfter = (game: AnalysisGame): number => {
  const history = game.repetitionHistory ?? [];
  const key = history[history.length - 1];
  return key === undefined ? 0 : history.filter((entry) => entry === key).length - 1;
};

const isCapture = (game: AnalysisGame, move: Move) =>
  game.grid[move.to.y]?.[move.to.x]?.occupant !== 'Empty';

/**
 * The worst a single enemy capture can make this position, or `null` when there
 * is none to make.
 *
 * Captures only, and one reply deep. That is not a search: it is the smallest
 * patch over the one thing a race reading structurally cannot see, which is that
 * the piece it just moved may simply be taken. Quiet replies are left to the
 * reading, which already assumes the opponent spends every move interfering.
 */
const worstCaptureReply = (
  game: AnalysisGame,
  color: SideColor,
  options: RacerOptions,
): number | null => {
  let worst: number | null = null;
  for (const reply of allValidMoves(game)) {
    if (!isCapture(game, reply)) continue;
    const played = applyAnalysisMove(game, reply.from, reply.to);
    if (!played) continue;
    const score =
      played.game.status === 'Finished'
        ? decidedScore(played.game, color)
        : scoreRace(played.game, color, options);
    if (worst === null || score < worst) worst = score;
  }
  return worst;
};

/** One legal move, graded by the race it leaves behind. */
export interface RankedRaceMove extends Move {
  score: number;
  /** 1 for the racer's own choice. */
  rank: number;
  /** The mover's reading of the position the move leads to. */
  mine: RaceReading;
  /** The opponent's reading of the same position. */
  theirs: RaceReading;
  /** Set when the move ends the game. */
  decided: 'win' | 'draw' | 'loss' | null;
}

/**
 * Every legal move, best first.
 *
 * Empty in a mode with no goal row, and empty when the game is over — both are
 * "this player has nothing to say about this position" rather than errors, and
 * `createRacerBot` is the one place that turns the first into a refusal.
 */
export const rankRaceMoves = (
  game: AnalysisGame,
  options: RacerOptions = RACER_DEFAULTS,
): RankedRaceMove[] => {
  if (!supportsReachRace(game.mode?.id)) return [];
  if (game.status !== 'InProgress') return [];
  const mover = game.currentTurn;
  if (mover === 'Neutral') return [];

  const ranked: RankedRaceMove[] = [];
  for (const move of allValidMoves(game)) {
    const played = applyAnalysisMove(game, move.from, move.to);
    if (!played) continue;
    const next = played.game;

    if (next.status === 'Finished') {
      const score = decidedScore(next, mover);
      ranked.push({
        ...move,
        score,
        rank: 0,
        mine: NO_RACE,
        theirs: NO_RACE,
        decided: score > 0 ? 'win' : score < 0 ? 'loss' : 'draw',
      });
      continue;
    }

    const maps = interceptionMaps(next.grid, options.obstacles);
    const mine = readRace(next, mover, options, maps);
    const theirs = readRace(next, opposingColor(mover), options, maps);
    let score =
      scoreReadings(next, mover, mine, theirs) - RACE_WEIGHTS.repeat * repeatsAfter(next);
    if (options.answerCaptures) {
      const worst = worstCaptureReply(next, mover, options);
      if (worst !== null && worst < score) score = worst;
    }
    ranked.push({ ...move, score, rank: 0, mine, theirs, decided: null });
  }

  ranked.sort((a, b) => b.score - a.score);
  return ranked.map((move, index) => ({ ...move, rank: index + 1 }));
};

/** The racer's move, or `null` when it has nothing to play. */
export const bestRaceMove = (
  game: AnalysisGame,
  options: RacerOptions = RACER_DEFAULTS,
): RankedRaceMove | null => rankRaceMoves(game, options)[0] ?? null;

/**
 * The same ranking dressed as an `Analysis`.
 *
 * Not a pretence at being RPSFish — the scores are the racer's own units and
 * `depth` is honestly 1 — but every surface that already consumes an analysis
 * (the arena's chart, a bot's candidate sampling, a hint) reads this shape, and
 * a player that cannot be plotted cannot be watched.
 */
export const raceAnalysis = (
  game: AnalysisGame,
  options: RacerOptions = RACER_DEFAULTS,
  variations = 1,
): Analysis => {
  const started = Date.now();
  const ranked = rankRaceMoves(game, options);
  const lines: EngineLine[] = ranked.slice(0, Math.max(1, variations)).map((move) => ({
    from: move.from,
    to: move.to,
    score: move.score,
    rank: move.rank,
    principalVariation: [{ from: move.from, to: move.to }],
  }));
  const score = lines[0]?.score ?? 0;
  return {
    confidence: 1,
    depth: 1,
    elapsedMs: Date.now() - started,
    lines,
    nodes: ranked.length,
    nodesPerSecond: 0,
    redScore: game.currentTurn === 'Blue' ? -score : score,
    score,
    selectiveDepth: options.answerCaptures ? 2 : 1,
    stopReason: lines.length === 0 ? 'no-legal-move' : 'depth',
  };
};
