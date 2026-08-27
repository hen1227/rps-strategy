// How far every square is, for one piece, and what that says about the race.
//
// Infiltration is won by walking a piece onto the far row, and every piece moves
// one king step, so the whole mode is a geometry problem: a square is "reachable
// in five" when a breadth-first walk gets there on its fifth layer, and a run to
// the goal is winning when no enemy piece of the one kind that captures this one
// can stand on any square of it first.
//
// Two things about the walk are worth knowing before reading it.
//
//   1. **A prey square is an ordinary passable node.** A rock steps onto an
//      enemy scissors, takes it, and carries on from there next move. So for one
//      walker's own shortest path, treating every square holding its prey as
//      passable is exact rather than approximate.
//   2. **Blockers stand still, and that is the approximation.** Real pieces move
//      out of the way, or into it. `ObstacleModel` exposes the brackets rather
//      than hiding a choice: `open` ignores every piece, `static` believes the
//      board as it stands, and `friendlyVacates` assumes your own pieces step
//      aside. Nothing here is a proof, and `analyzeReach` says so in its own
//      comment.
//
// The movement rule itself is not repeated here. It lives once, in
// `stepTargets`, and this module reads the same passability out of it.
//
// **This module is nine by nine, on purpose.** Every walk below allocates
// `BOARD_SIZE` squares, and the only mode with a goal row to race to is
// Infiltration, which is that size. A mode may now be any rectangle, so the
// gate is `supportsReachRace`: it answers false for anything but Infiltration,
// and `useReach` is the single place that asks. Generalising the walks would
// mean threading a shape through six of them for a study tool no other mode has
// a use for; refusing to draw a picture that would be wrong is the honest
// answer until one does.

import {
  canCapture,
  predatorOf,
  type PositionLike,
} from './analysisGame';
import {
  BOARD_SIZE,
  opposingColor,
  type Grid,
  type ModeID,
  type PlayablePiece,
  type Position,
  type SideColor,
} from '@/types/game';

/** No walk reaches this square at all. */
export const UNREACHABLE = Number.POSITIVE_INFINITY;

/** Moves to every square, indexed `[y][x]`. `UNREACHABLE` where there is no route. */
export type DistanceMap = number[][];

/** What a walk believes about the pieces standing on the board. */
export type ObstacleModel =
  /** Ignore every piece. Pure king-step geometry, which is Chebyshev distance. */
  | 'open'
  /** The board as it stands: friends and enemies this kind cannot take both block. */
  | 'static'
  /** As `static`, but your own pieces are assumed to step aside. */
  | 'friendlyVacates';

/** One piece making a walk. The ghost piece is a walker with nothing under it. */
export interface Walker {
  from: Position;
  piece: PlayablePiece;
  owner: SideColor;
}

const MODE_INFILTRATION: ModeID = 'V3';

/**
 * The row this side wins by reaching, or `null` in a mode with no such row.
 *
 * The one place a mode-specific rule enters this module. It is the same rule
 * `applyAnalysisMove` decides infiltration with and `tintForTile` draws the goal
 * rank from; a mode that later wins some other way is an edit here.
 */
export const goalRowFor = (modeId: ModeID | undefined, color: SideColor): number | null =>
  modeId === MODE_INFILTRATION ? (color === 'Red' ? 0 : BOARD_SIZE - 1) : null;

/**
 * Whether the race analysis means anything in this mode.
 *
 * Also the board-shape gate for the whole module — see the note at the top.
 * Infiltration is nine by nine and everything here assumes it.
 */
export const supportsReachRace = (modeId: ModeID | undefined) =>
  goalRowFor(modeId, 'Red') !== null;

const emptyMap = (): DistanceMap =>
  Array.from({ length: BOARD_SIZE }, () => new Array<number>(BOARD_SIZE).fill(UNREACHABLE));

/**
 * Which squares this walker may stand on, as a flat grid of booleans.
 *
 * Computed once per walk rather than asking `stepTargets` at every node: the
 * answer depends only on the walker's kind and colour, which never change
 * mid-walk because nothing in this game promotes.
 */
const passableFor = (grid: Grid, walker: Walker, obstacles: ObstacleModel): boolean[][] =>
  Array.from({ length: BOARD_SIZE }, (_unusedRow, y) =>
    Array.from({ length: BOARD_SIZE }, (_unusedTile, x) => {
      if (x === walker.from.x && y === walker.from.y) return true;
      if (obstacles === 'open') return true;
      const tile = grid[y]?.[x];
      if (!tile || tile.occupant === 'Empty') return true;
      if (tile.occupantOwner === walker.owner) return obstacles === 'friendlyVacates';
      return canCapture(walker.piece, tile.occupant);
    }),
  );

const NEIGHBOUR_OFFSETS: readonly (readonly [number, number])[] = [
  [-1, -1], [0, -1], [1, -1],
  [-1, 0], [1, 0],
  [-1, 1], [0, 1], [1, 1],
];

/** Moves for this walker to stand on each square. */
export const reachMap = (
  grid: Grid,
  walker: Walker,
  obstacles: ObstacleModel,
): DistanceMap => {
  const passable = passableFor(grid, walker, obstacles);
  const distance = emptyMap();
  distance[walker.from.y][walker.from.x] = 0;

  let frontier: Position[] = [walker.from];
  let step = 0;
  while (frontier.length > 0) {
    step += 1;
    const next: Position[] = [];
    for (const { x, y } of frontier) {
      for (const [xOffset, yOffset] of NEIGHBOUR_OFFSETS) {
        const toX = x + xOffset;
        const toY = y + yOffset;
        if (toX < 0 || toX >= BOARD_SIZE || toY < 0 || toY >= BOARD_SIZE) continue;
        if (!passable[toY][toX]) continue;
        if (distance[toY][toX] !== UNREACHABLE) continue;
        distance[toY][toX] = step;
        next.push({ x: toX, y: toY });
      }
    }
    frontier = next;
  }
  return distance;
};

/** The per-square minimum of several walks: whoever gets there first. */
export const mergeMaps = (maps: readonly DistanceMap[]): DistanceMap => {
  const merged = emptyMap();
  for (const map of maps) {
    for (let y = 0; y < BOARD_SIZE; y += 1) {
      for (let x = 0; x < BOARD_SIZE; x += 1) {
        if (map[y][x] < merged[y][x]) merged[y][x] = map[y][x];
      }
    }
  }
  return merged;
};

/**
 * Every enemy piece that could capture this walker.
 *
 * Exactly one kind, always: the hierarchy is a single three-cycle. When this
 * returns nothing the walker is *immortal* — no mode ever puts a piece back on
 * the board, so a kind whose predators are all gone can never be taken again.
 * `Position::is_immortal_kind` in RPSFish is the same fact.
 */
export const predators = (grid: Grid, walker: Walker): Walker[] => {
  const hunter = predatorOf(walker.piece);
  const enemy = opposingColor(walker.owner);
  const found: Walker[] = [];
  for (let y = 0; y < BOARD_SIZE; y += 1) {
    for (let x = 0; x < BOARD_SIZE; x += 1) {
      const tile = grid[y]?.[x];
      if (tile?.occupant === hunter && tile.occupantOwner === enemy) {
        found.push({ from: { x, y }, piece: hunter, owner: enemy });
      }
    }
  }
  return found;
};

/** Moves before some enemy predator could be standing on each square. */
export const threatMap = (
  grid: Grid,
  walker: Walker,
  obstacles: ObstacleModel,
): DistanceMap =>
  mergeMaps(predators(grid, walker).map((hunter) => reachMap(grid, hunter, obstacles)));

/** How a run decides a square is too dangerous to stand on. */
export type SafetyRule =
  /** Safe on a square as long as no predator can be there by the move you arrive. */
  | 'perStep'
  /** Safe only on squares no predator reaches within the run's whole length. */
  | 'wholeRun'
  /** Ignore predators entirely: the shortest route, whatever it costs. */
  | 'off';

export interface RunOptions {
  obstacles: ObstacleModel;
  safety: SafetyRule;
  /** True when the walker's own side moves next. Shifts the interception clock by one. */
  walkerToMove: boolean;
  /** Landing on the goal row ends the game, so the last square needs no margin. */
  goalEndsGame: boolean;
}

export interface SafeRun {
  /** The walker's square first, the goal square last. */
  path: Position[];
  moves: number;
  /** How long a predator needs to reach each square of the path. */
  threatAlong: number[];
}

/**
 * Whether the walker may be standing on a square after `step` of its own moves.
 *
 * Count the plies. With the walker to move the order is W₁ E₁ W₂ E₂ …, so after
 * the walker's move `k` the enemy has played `k − 1` and is about to play its
 * `k`th: a predator that needs `k` moves or fewer takes the piece. Safety is
 * therefore `threat > k`. When the enemy moves first it has had one more move by
 * the same point, and the bound tightens to `threat > k + 1`.
 *
 * Note this is *monotone decreasing in `step`* — arriving later is never easier
 * — which is what makes a plain layered walk both correct and complete below.
 * If a square is unusable at its earliest arrival it is unusable at every later
 * one, so there is no reason to revisit it.
 */
const safeAtStep = (threat: number, step: number, walkerToMove: boolean) =>
  threat > step + (walkerToMove ? 0 : 1);

const tracePath = (
  parent: (Position | null)[][],
  end: Position,
): Position[] => {
  const path: Position[] = [];
  let cursor: Position | null = end;
  while (cursor) {
    path.push(cursor);
    cursor = parent[cursor.y][cursor.x];
  }
  return path.reverse();
};

const runFrom = (
  path: Position[],
  threat: DistanceMap,
): SafeRun => ({
  path,
  moves: path.length - 1,
  threatAlong: path.map(({ x, y }) => threat[y][x]),
});

/**
 * A walk to the goal row that keeps to squares a predator cannot reach in time.
 *
 * `perStep` is one layered walk, for the monotonicity reason above. `wholeRun`
 * cannot use it — its rule mentions the finished run's length, which is not
 * known while walking — so it asks the question the other way round: for each
 * candidate length `n`, restrict the board to the squares no predator reaches
 * inside `n` moves and see whether the goal is `n` steps away in what is left.
 * The allowed set only shrinks as `n` grows, so the first `n` that works is the
 * answer, and at that `n` the distance is exactly `n`.
 */
export const safeRun = (
  grid: Grid,
  walker: Walker,
  goalRow: number,
  options: RunOptions,
  /** The walker's threat map, when the caller already has one. */
  precomputedThreat?: DistanceMap,
): SafeRun | null => {
  const threat =
    options.safety === 'off'
      ? emptyMap()
      : precomputedThreat ?? threatMap(grid, walker, options.obstacles);
  const passable = passableFor(grid, walker, options.obstacles);
  const exempt = (y: number) => options.goalEndsGame && y === goalRow;

  if (options.safety === 'wholeRun') {
    for (let length = 1; length <= BOARD_SIZE * BOARD_SIZE; length += 1) {
      const walk = boundedWalk(
        walker.from,
        goalRow,
        (x, y) => passable[y][x] && (exempt(y) || threat[y][x] >= length),
      );
      if (walk && walk.length - 1 <= length) return runFrom(walk, threat);
    }
    return null;
  }

  const walk = boundedWalk(walker.from, goalRow, (x, y, step) => {
    if (!passable[y][x]) return false;
    if (options.safety === 'off' || exempt(y)) return true;
    return safeAtStep(threat[y][x], step, options.walkerToMove);
  });
  return walk ? runFrom(walk, threat) : null;
};

/**
 * The shortest walk from `start` to any square on `goalRow`, or `null`.
 *
 * `allowed` is asked about each square as it is first reached, with the step it
 * would be reached on, which is all a step-indexed safety rule needs.
 */
const boundedWalk = (
  start: Position,
  goalRow: number,
  allowed: (x: number, y: number, step: number) => boolean,
): Position[] | null => {
  if (start.y === goalRow) return [start];
  const seen = Array.from({ length: BOARD_SIZE }, () =>
    new Array<boolean>(BOARD_SIZE).fill(false),
  );
  const parent: (Position | null)[][] = Array.from({ length: BOARD_SIZE }, () =>
    new Array<Position | null>(BOARD_SIZE).fill(null),
  );
  seen[start.y][start.x] = true;

  let frontier: Position[] = [start];
  let step = 0;
  while (frontier.length > 0) {
    step += 1;
    const next: Position[] = [];
    for (const from of frontier) {
      for (const [xOffset, yOffset] of NEIGHBOUR_OFFSETS) {
        const x = from.x + xOffset;
        const y = from.y + yOffset;
        if (x < 0 || x >= BOARD_SIZE || y < 0 || y >= BOARD_SIZE) continue;
        if (seen[y][x]) continue;
        seen[y][x] = true;
        if (!allowed(x, y, step)) continue;
        parent[y][x] = from;
        if (y === goalRow) return tracePath(parent, { x, y });
        next.push({ x, y });
      }
    }
    frontier = next;
  }
  return null;
};

/** The nearest square of one row, in moves. */
export const distanceToRow = (map: DistanceMap, row: number): number => {
  let best = UNREACHABLE;
  for (let x = 0; x < BOARD_SIZE; x += 1) {
    if (map[row][x] < best) best = map[row][x];
  }
  return best;
};

/** The square where the quickest route stops being survivable, if it does. */
export interface CutOff {
  at: Position;
  /** Moves a predator needs to stand there. */
  threat: number;
  /** The move of the run on which the walker would arrive. */
  arrivalStep: number;
}

export interface PieceReading {
  walker: Walker;
  /** Straight-line moves to the goal row, ignoring every piece. */
  openDistance: number;
  /** Moves to the goal row through the pieces that are actually there. */
  blockedDistance: number;
  /** Moves along the quickest run nothing can cut off, or `null` when there is none. */
  safeDistance: number | null;
  safeRun: SafeRun | null;
  /** Moves before a predator could take this piece where it stands. */
  attackedIn: number;
  /** No enemy piece of the kind that captures this one is left on the board. */
  immortal: boolean;
  predatorCount: number;
  /** Why the quickest route is not the safe one. */
  cutOff: CutOff | null;
}

export interface RaceVerdict {
  red: PieceReading | null;
  blue: PieceReading | null;
  toMove: SideColor;
  winner: SideColor | null;
  /**
   * Moves the winner has to spare.
   *
   * The side to move arrives on ply `2n − 1` and the other on ply `2n`, so the
   * side to move is first whenever its run is no longer than its opponent's.
   * Zero is still a win for the side to move and still a loss for the side that
   * is a tempo behind.
   */
  margin: number | null;
}

export interface ReachAnalysis {
  /** Every piece on the board, in board order. */
  readings: PieceReading[];
  verdict: RaceVerdict;
}

export interface ReachOptions {
  obstacles: ObstacleModel;
  safety: SafetyRule;
  goalEndsGame: boolean;
  /** Which side is treated as moving next. */
  toMove: SideColor;
}

/** Every piece standing on the board, in board order. */
export const walkersOn = (grid: Grid): Walker[] => {
  const walkers: Walker[] = [];
  for (let y = 0; y < BOARD_SIZE; y += 1) {
    for (let x = 0; x < BOARD_SIZE; x += 1) {
      const tile = grid[y]?.[x];
      if (!tile || tile.occupant === 'Empty') continue;
      if (tile.occupantOwner === 'Neutral') continue;
      walkers.push({ from: { x, y }, piece: tile.occupant, owner: tile.occupantOwner });
    }
  }
  return walkers;
};

/**
 * Threat maps keyed by side and kind.
 *
 * Every red rock is hunted by the same blue papers, so the expensive half of a
 * reading is shared by up to nine pieces. Six entries covers a whole board.
 */
const threatCache = (grid: Grid, obstacles: ObstacleModel) => {
  const cache = new Map<string, DistanceMap>();
  return (walker: Walker): DistanceMap => {
    const key = `${walker.owner}:${walker.piece}`;
    const cached = cache.get(key);
    if (cached) return cached;
    const map = threatMap(grid, walker, obstacles);
    cache.set(key, map);
    return map;
  };
};

const findCutOff = (
  grid: Grid,
  walker: Walker,
  goalRow: number,
  threat: DistanceMap,
  options: RunOptions,
): CutOff | null => {
  const passable = passableFor(grid, walker, options.obstacles);
  const quickest = boundedWalk(walker.from, goalRow, (x, y) => passable[y][x]);
  if (!quickest) return null;
  for (let step = 1; step < quickest.length; step += 1) {
    const square = quickest[step];
    if (options.goalEndsGame && square.y === goalRow) continue;
    if (!safeAtStep(threat[square.y][square.x], step, options.walkerToMove)) {
      return { at: square, threat: threat[square.y][square.x], arrivalStep: step };
    }
  }
  return null;
};

const readPiece = (
  grid: Grid,
  walker: Walker,
  goalRow: number,
  options: ReachOptions,
  threatFor: (walker: Walker) => DistanceMap,
): PieceReading => {
  const runOptions: RunOptions = {
    obstacles: options.obstacles,
    safety: options.safety,
    walkerToMove: walker.owner === options.toMove,
    goalEndsGame: options.goalEndsGame,
  };
  const threat = threatFor(walker);
  const hunters = predators(grid, walker);
  const run = safeRun(grid, walker, goalRow, runOptions, threat);
  const blockedDistance = distanceToRow(reachMap(grid, walker, options.obstacles), goalRow);

  return {
    walker,
    openDistance: distanceToRow(reachMap(grid, walker, 'open'), goalRow),
    blockedDistance,
    safeDistance: run ? run.moves : null,
    safeRun: run,
    attackedIn: threat[walker.from.y][walker.from.x],
    immortal: hunters.length === 0,
    predatorCount: hunters.length,
    cutOff:
      run && run.moves === blockedDistance
        ? null
        : findCutOff(grid, walker, goalRow, threat, runOptions),
  };
};

const fastest = (readings: readonly PieceReading[], color: SideColor): PieceReading | null => {
  let best: PieceReading | null = null;
  for (const reading of readings) {
    if (reading.walker.owner !== color || reading.safeDistance === null) continue;
    if (!best || reading.safeDistance < (best.safeDistance ?? Infinity)) best = reading;
  }
  return best;
};

const judge = (
  red: PieceReading | null,
  blue: PieceReading | null,
  toMove: SideColor,
): Pick<RaceVerdict, 'winner' | 'margin'> => {
  const redMoves = red?.safeDistance ?? null;
  const blueMoves = blue?.safeDistance ?? null;
  if (redMoves === null && blueMoves === null) return { winner: null, margin: null };
  if (redMoves === null) return { winner: 'Blue', margin: null };
  if (blueMoves === null) return { winner: 'Red', margin: null };

  const mine = toMove === 'Red' ? redMoves : blueMoves;
  const theirs = toMove === 'Red' ? blueMoves : redMoves;
  return mine <= theirs
    ? { winner: toMove, margin: theirs - mine }
    : { winner: opposingColor(toMove), margin: mine - theirs - 1 };
};

/**
 * Every piece's route to the goal, and who gets there first.
 *
 * **This is a bound, not a proof.** It treats blockers as though they stand
 * still, and it credits the defender with playing as a pure interceptor rather
 * than rerouting, blocking, or counter-racing. A side with no safe run here may
 * still have one after a capture opens the board, and a side with one may still
 * lose it to a move this model never considers. What it is good for is seeing
 * *why* — `cutOff` names the square that decides a race, and `immortal` is the
 * one reading that really is conclusive.
 *
 * `null` in a mode with no goal row to race to.
 */
export const analyzeReach = (
  position: PositionLike,
  options: ReachOptions,
): ReachAnalysis | null => {
  const redGoal = goalRowFor(position.mode?.id, 'Red');
  const blueGoal = goalRowFor(position.mode?.id, 'Blue');
  if (redGoal === null || blueGoal === null) return null;

  const threatFor = threatCache(position.grid, options.obstacles);
  const readings = walkersOn(position.grid).map((walker) =>
    readPiece(
      position.grid,
      walker,
      walker.owner === 'Red' ? redGoal : blueGoal,
      options,
      threatFor,
    ),
  );

  const red = fastest(readings, 'Red');
  const blue = fastest(readings, 'Blue');
  return {
    readings,
    verdict: { red, blue, toMove: options.toMove, ...judge(red, blue, options.toMove) },
  };
};
