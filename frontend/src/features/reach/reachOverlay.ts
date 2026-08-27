// Distances turned into something a board can paint.
//
// Everything that decides what a square *looks* like lives here rather than in
// a component: the banding, the labels, which wash wins when two apply, and how
// a ghost piece is written into the position before any of it is measured. That
// keeps it a pure function of a position and a settings object — the same input
// the panel shows and the same input a test can hand it.
//
// `engine/reach.ts` owns the arithmetic. Nothing here recomputes a distance.

import {
  UNREACHABLE,
  analyzeReach,
  goalRowFor,
  mergeMaps,
  reachMap,
  threatMap,
  type DistanceMap,
  type PieceReading,
  type ReachAnalysis,
  type ReachOptions,
  type Walker,
} from '@/engine/reach';
import { pieceLetter, predatorOf, squareLabel, type PositionLike } from '@/engine/analysisGame';
import {
  emptyOverlayCells,
  type BoardOverlay,
  type OverlayCell,
  type OverlayLabel,
} from '@/features/board/overlay';
import type { ReachSettings } from './settings';
import { REACH_BANDS, players, reach } from '@/theme';
import {
  BOARD_SIZE,
  PLAYABLE_PIECES,
  type Grid,
  type PlayablePiece,
  type Position,
  type SideColor,
} from '@/types/game';

export interface ReachOverlayResult {
  overlay: BoardOverlay | null;
  analysis: ReachAnalysis | null;
  /** The piece the piece, threat and run views are following. */
  focus: Walker | null;
  /** That piece's row of the summary table, when it is on the analysed board. */
  focusReading: PieceReading | null;
  /** The position the numbers describe — the board plus the ghost, if there is one. */
  grid: Grid;
}

const NOTHING: ReachOverlayResult = {
  overlay: null,
  analysis: null,
  focus: null,
  focusReading: null,
  grid: [],
};

/** The board with the ghost standing on it, or the board itself. */
const withGhost = (grid: Grid, settings: ReachSettings): Grid => {
  const ghost = settings.ghost;
  if (!ghost) return grid;
  return grid.map((row, y) =>
    row.map((tile, x) =>
      x === ghost.at.x && y === ghost.at.y
        ? { ...tile, occupant: ghost.piece, occupantOwner: ghost.owner }
        : tile,
    ),
  );
};

const walkerAt = (grid: Grid, at: Position | null): Walker | null => {
  if (!at) return null;
  const tile = grid[at.y]?.[at.x];
  if (!tile || tile.occupant === 'Empty' || tile.occupantOwner === 'Neutral') return null;
  return { from: { x: at.x, y: at.y }, piece: tile.occupant, owner: tile.occupantOwner };
};

/**
 * The piece the single-piece views follow.
 *
 * The ghost wins when there is one — placing it is an explicit question. After
 * that, whatever was last tapped, and failing that the side's own best runner,
 * so the tool says something useful the moment it is switched on.
 */
const resolveFocus = (
  grid: Grid,
  settings: ReachSettings,
  analysis: ReachAnalysis | null,
): Walker | null => {
  if (settings.ghost) {
    return { from: settings.ghost.at, piece: settings.ghost.piece, owner: settings.ghost.owner };
  }
  const tapped = walkerAt(grid, settings.focus);
  if (tapped) return tapped;

  const best =
    settings.side === 'Red' ? analysis?.verdict.red : analysis?.verdict.blue;
  if (best) return best.walker;

  const own = analysis?.readings.filter((reading) => reading.walker.owner === settings.side) ?? [];
  const nearest = own.reduce<PieceReading | null>(
    (found, reading) =>
      !found || reading.blockedDistance < found.blockedDistance ? reading : found,
    null,
  );
  return nearest?.walker ?? null;
};

const matchesKind = (walker: Walker, kind: PlayablePiece | 'all') =>
  kind === 'all' || walker.piece === kind;

/** One kind's distances for one side, written with the letter it is read as. */
export interface KindMap {
  kind: PlayablePiece;
  map: DistanceMap;
}

/**
 * One map per kind, rather than one map for the side.
 *
 * A side's kinds are not interchangeable — a rock and a paper are stopped by
 * different pieces and hunted by different ones — so merging them into a single
 * "how far is this side from here" number answers a question nobody is asking.
 * Each kind keeps its own walk, and a square that several can reach says so:
 * `R3 P4 S5`.
 *
 * Kinds with no pieces left drop out, so an army of two shows two lines.
 */
const sideMapsByKind = (
  grid: Grid,
  analysis: ReachAnalysis,
  settings: ReachSettings,
  color: SideColor,
): KindMap[] =>
  PLAYABLE_PIECES.filter((kind) => settings.kind === 'all' || settings.kind === kind)
    .map((kind) => ({
      kind,
      walkers: analysis.readings
        .map((reading) => reading.walker)
        .filter((walker) => walker.owner === color && walker.piece === kind),
    }))
    .filter(({ walkers }) => walkers.length > 0)
    .map(({ kind, walkers }) => ({
      kind,
      map: mergeMaps(walkers.map((walker) => reachMap(grid, walker, settings.obstacles))),
    }));

/** The nearest of a side's kinds to one square, and which kind that is. */
const nearestKind = (maps: readonly KindMap[], x: number, y: number) =>
  maps.reduce<{ kind: PlayablePiece; moves: number } | null>((found, { kind, map }) => {
    const moves = map[y][x];
    if (moves === UNREACHABLE) return found;
    return !found || moves < found.moves ? { kind, moves } : found;
  }, null);

const token = (kind: PlayablePiece, moves: number) => `${pieceLetter(kind)}${moves}`;

/** The wash for a distance, over whichever colour of square it lands on. */
const bandFor = (color: SideColor, moves: number, x: number, y: number): string => {
  const isLight = (x + y) % 2 === 0;
  const ramp = isLight ? players[color].reachOnLight : players[color].reachOnDark;
  return ramp[Math.min(moves, REACH_BANDS - 1)];
};

const numberColor = (x: number, y: number) =>
  (x + y) % 2 === 0 ? reach.numberOnLight : reach.numberOnDark;

/**
 * A number in one side's colour, still readable on either square.
 *
 * The same two-tone problem the bands have: the strong hue reads on the sand
 * tile and disappears into the green one, so the dark tile takes the pale hue.
 */
const sideNumberColor = (color: SideColor, x: number, y: number) =>
  (x + y) % 2 === 0 ? players[color].strong : players[color].contrast;

/** The hunter's distance, readable over the danger wash on either square. */
const hunterNumberColor = (x: number, y: number) =>
  (x + y) % 2 === 0 ? reach.hunterOnLight : reach.hunterOnDark;

/** Whether this distance is inside the range being asked about. */
const inRange = (moves: number, settings: ReachSettings) =>
  settings.maxMoves === 0 || moves <= settings.maxMoves;

const positionKey = ({ x, y }: Position) => `${x}:${y}`;

const toMoveFor = (position: PositionLike, settings: ReachSettings): SideColor => {
  if (settings.tempo !== 'position') return settings.tempo;
  return position.currentTurn === 'Blue' ? 'Blue' : 'Red';
};

export const reachOptionsFrom = (
  position: PositionLike,
  settings: ReachSettings,
): ReachOptions => ({
  obstacles: settings.obstacles,
  safety: settings.safety,
  goalEndsGame: settings.goalEndsGame,
  toMove: toMoveFor(position, settings),
});

/**
 * A finished overlay for the board, and the analysis behind it.
 *
 * `null` overlay in a mode with no goal row, or with the tool switched off, so
 * a caller can pass the result straight to `<Board overlay={…} />` either way.
 */
export const buildReachOverlay = (
  position: PositionLike | null | undefined,
  settings: ReachSettings,
): ReachOverlayResult => {
  if (!position || !settings.enabled) return NOTHING;
  if (goalRowFor(position.mode?.id, 'Red') === null) return NOTHING;

  const grid = withGhost(position.grid, settings);
  const analysis = analyzeReach({ ...position, grid }, reachOptionsFrom(position, settings));
  if (!analysis) return NOTHING;

  const focus = resolveFocus(grid, settings, analysis);
  const focusReading =
    analysis.readings.find(
      (reading) =>
        focus &&
        reading.walker.from.x === focus.from.x &&
        reading.walker.from.y === focus.from.y,
    ) ?? null;

  // Nine by nine, like the rest of the reach tool: `supportsReachRace` is what
  // keeps this off any other board. See the note at the top of `engine/reach.ts`.
  const cells = emptyOverlayCells(BOARD_SIZE, BOARD_SIZE);
  const write = (x: number, y: number, cell: OverlayCell) => {
    cells[y][x] = { ...(cells[y][x] ?? {}), ...cell };
  };
  /** Add a line under whatever the square already says, rather than replacing it. */
  const addLabel = (x: number, y: number, label: OverlayLabel) => {
    const current = cells[y][x];
    if (!current) return;
    cells[y][x] = { ...current, labels: [...(current.labels ?? []), label] };
  };

  /**
   * One side's kinds, banded by the nearest of them and numbered one per kind.
   *
   * The wash is the nearest kind's distance — a heat map wants one number — but
   * the corner carries every kind that can get there inside the range, so a
   * square reads `R3 P4` rather than a `3` that hides which piece it belongs to.
   */
  const paintKinds = (maps: readonly KindMap[], color: SideColor) => {
    for (let y = 0; y < BOARD_SIZE; y += 1) {
      for (let x = 0; x < BOARD_SIZE; x += 1) {
        const nearest = nearestKind(maps, x, y);
        if (!nearest) continue;
        const within = inRange(nearest.moves, settings);
        if (!within && !settings.dimBeyond) continue;

        const shown = maps
          .map(({ kind, map }) => ({ kind, moves: map[y][x] }))
          .filter(({ moves }) => moves !== UNREACHABLE && (within ? inRange(moves, settings) : moves === nearest.moves));

        write(x, y, {
          fill: bandFor(color, nearest.moves, x, y),
          dim: !within,
          labels: settings.showNumbers
            ? shown.map(({ kind, moves }) => ({ text: token(kind, moves), color: numberColor(x, y) }))
            : undefined,
          describe: `${color} ${shown.map(({ kind, moves }) => `${kind} in ${moves}`).join(', ')}`,
        });
        if (within && settings.showFrontier && nearest.moves === settings.maxMoves) {
          write(x, y, { ring: reach.frontierRing });
        }
      }
    }
  };

  let legend = '';

  if (settings.view === 'piece' || settings.view === 'threat' || settings.view === 'run') {
    if (focus) {
      paintKinds(
        [{ kind: focus.piece, map: reachMap(grid, focus, settings.obstacles) }],
        focus.owner,
      );
      legend = `${focus.owner} ${focus.piece} on ${squareLabel(focus.from)}`;
    }
  } else if (settings.view === 'side') {
    paintKinds(sideMapsByKind(grid, analysis, settings, settings.side), settings.side);
    legend = `${settings.side} reach, by kind`;
  } else {
    // Both sides at once, one line each: whose kind gets here, and in how many.
    // Two lines rather than six — every kind of both sides would not fit a
    // square and would not be read if it did.
    const red = sideMapsByKind(grid, analysis, settings, 'Red');
    const blue = sideMapsByKind(grid, analysis, settings, 'Blue');
    for (let y = 0; y < BOARD_SIZE; y += 1) {
      for (let x = 0; x < BOARD_SIZE; x += 1) {
        const nearestRed = nearestKind(red, x, y);
        const nearestBlue = nearestKind(blue, x, y);
        if (!nearestRed && !nearestBlue) continue;
        const moves = Math.min(nearestRed?.moves ?? UNREACHABLE, nearestBlue?.moves ?? UNREACHABLE);
        const within = inRange(moves, settings);
        if (!within && !settings.dimBeyond) continue;

        const tied = nearestRed && nearestBlue && nearestRed.moves === nearestBlue.moves;
        const owner: SideColor =
          (nearestRed?.moves ?? UNREACHABLE) < (nearestBlue?.moves ?? UNREACHABLE) ? 'Red' : 'Blue';
        const lines: { side: SideColor; kind: PlayablePiece; moves: number }[] = [
          ...(nearestRed ? [{ side: 'Red' as const, ...nearestRed }] : []),
          ...(nearestBlue ? [{ side: 'Blue' as const, ...nearestBlue }] : []),
        ];

        write(x, y, {
          fill: tied ? reach.contestedTie : bandFor(owner, moves, x, y),
          dim: !within,
          labels: settings.showNumbers
            ? lines.map((line) => ({
                text: token(line.kind, line.moves),
                color: sideNumberColor(line.side, x, y),
              }))
            : undefined,
          describe: tied
            ? `contested in ${moves}`
            : `${owner} first in ${moves}, with a ${
                owner === 'Red' ? nearestRed?.kind : nearestBlue?.kind
              }`,
        });
        if (within && settings.showFrontier && moves === settings.maxMoves) {
          write(x, y, { ring: reach.frontierRing });
        }
      }
    }
    legend = 'Whoever reaches each square first, and with which kind';
  }

  // Everything below belongs to the focused piece, so none of it is drawn on
  // the one view that is not about a piece. A contest map answers "who owns
  // this square"; hanging one rock's danger wash and cut-off square on it would
  // be two questions in one picture.
  const focusLayers = focus !== null && settings.view !== 'contest';

  // The squares a predator owns. Drawn over the bands on purpose: on a run,
  // where the killer gets to first is the only thing that matters.
  const showThreat = focusLayers && (settings.view === 'threat' || settings.showDanger);
  if (showThreat && focus) {
    const threat = threatMap(grid, focus, settings.obstacles);
    const own = reachMap(grid, focus, settings.obstacles);
    for (let y = 0; y < BOARD_SIZE; y += 1) {
      for (let x = 0; x < BOARD_SIZE; x += 1) {
        if (threat[y][x] === UNREACHABLE) continue;
        if (own[y][x] === UNREACHABLE) continue;
        const within = inRange(own[y][x], settings);
        if (!within && !settings.dimBeyond) continue;
        // Beaten there, or arriving at the same time, which loses the square
        // to whoever moves next.
        if (threat[y][x] > own[y][x]) continue;
        write(x, y, {
          fill: reach.danger,
          // Follows the band underneath it: a square pushed back for being out
          // of range should not come forward again for being dangerous.
          dim: !within,
          describe: `${predatorOf(focus.piece)} there in ${threat[y][x]}`,
        });
      }
    }

    // The threat view puts the hunter's number under the runner's, on every
    // square it can reach rather than only the ones it wins. `R5` over `P3` is
    // the comparison the whole tool is for, and reading it off two views was
    // the thing that made it hard.
    if (settings.view === 'threat' && settings.showNumbers) {
      const hunter = predatorOf(focus.piece);
      for (let y = 0; y < BOARD_SIZE; y += 1) {
        for (let x = 0; x < BOARD_SIZE; x += 1) {
          if (threat[y][x] === UNREACHABLE) continue;
          if (!inRange(threat[y][x], settings)) continue;
          addLabel(x, y, { text: token(hunter, threat[y][x]), color: hunterNumberColor(x, y) });
        }
      }
    }
    if (settings.view === 'threat') {
      legend = `${legend}, against the pieces that capture it`;
    }
  }

  // The run last, so it reads over both the bands and the danger wash.
  const run = focusReading?.safeRun ?? null;
  if (focusLayers && focus && run && (settings.showPath || settings.view === 'run')) {
    run.path.forEach((square, step) => {
      write(square.x, square.y, {
        fill: reach.path,
        ring: reach.pathRing,
        dim: false,
        // A bare number, deliberately unlike the lettered distances around it:
        // this is the move of the run, not how far anything reaches.
        labels: settings.showNumbers
          ? [{ text: String(step), color: numberColor(square.x, square.y) }]
          : undefined,
        describe: `run step ${step}`,
      });
    });
    if (settings.view === 'run') legend = `${legend}, running in ${run.moves}`;
  }

  const cutOff = focusReading?.cutOff ?? null;
  if (focusLayers && cutOff && (settings.view === 'run' || settings.showDanger)) {
    write(cutOff.at.x, cutOff.at.y, {
      fill: reach.danger,
      ring: reach.dangerRing,
      dim: false,
      describe: `cut off here on move ${cutOff.arrivalStep}`,
    });
  }

  if (settings.ghost) {
    write(settings.ghost.at.x, settings.ghost.at.y, {
      ring: reach.ghostRing,
      dim: false,
      describe: `hypothetical ${settings.ghost.owner} ${settings.ghost.piece}`,
    });
  }

  return { overlay: { cells, legend }, analysis, focus, focusReading, grid };
};

/** Which squares an overlay actually says something about, for a test or a count. */
export const paintedSquares = (overlay: BoardOverlay | null): string[] => {
  if (!overlay) return [];
  const painted: string[] = [];
  for (let y = 0; y < BOARD_SIZE; y += 1) {
    for (let x = 0; x < BOARD_SIZE; x += 1) {
      if (overlay.cells[y][x]) painted.push(positionKey({ x, y }));
    }
  }
  return painted;
};
