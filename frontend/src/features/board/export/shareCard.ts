// A board, laid out as a picture somebody can post.
//
// Deliberately a *plan* rather than a drawing: this module computes where every
// rectangle, letter and piece goes and hands back a list, and `shareImage.web`
// paints that list onto a canvas. The split is what makes the card testable —
// "a board with nothing captured has no tray", "turning every extra off leaves
// the board and nothing else" are assertions about geometry, and geometry is
// the part that goes wrong. A renderer that measured text would also be a
// renderer that could only be checked by looking at it.
//
// It draws the same board the screen does, from the same palette and the same
// `tintForTile`, because the point of the picture is that it is recognisably
// this app's board. Nothing here re-decides what a tile means.

import type { RulesEra } from '@/engine/goals';
import { board as boardTheme, clock as clockTheme, colors, players } from '@/theme';
import {
  PLAYABLE_PIECES,
  opposingColor,
  type Grid,
  type ModeDefinition,
  type Move,
  type PlayablePiece,
  type PlayerColor,
  type SideColor,
} from '@/types/game';

import type { PieceTally } from '../CapturedPieces';
import { tintForTile } from '../tint';

// Files as the board labels them, the same twenty-six `Board` uses.
const FILES = 'abcdefghijklmnopqrstuvwxyz';

// Points, multiplied by the scale the rasterizer is asked for. Sized so that a
// nine by nine board exports at 1080 across at scale 2, which is the width
// every social site downsamples to.
const TILE = 54;
const FRAME = 4;
const PAD = 18;
const GAP = 10;
const HEADING_HEIGHT = 26;
const BAND_HEIGHT = 46;
const FOOTER_HEIGHT = 20;
/** Between the board and a band, which sit closer than anything else does. */
const BOARD_GAP = 6;
/** A band needs room for a name, a tray and a clock even over a tiny board. */
const MINIMUM_BAND_WIDTH = 344;

const MONOGRAM = 26;
const CLOCK_WIDTH = 68;
const CLOCK_HEIGHT = 26;
const TRAY_PIECE = 18;
/** How far a piece in a tray sits over the one before it, as `CapturedPieces`. */
const TRAY_OVERLAP = 0.45;

/** One drawing instruction. The rasterizer understands exactly these three. */
export type CardShape =
  | {
      kind: 'rect';
      x: number;
      y: number;
      width: number;
      height: number;
      fill?: string;
      stroke?: string;
      strokeWidth?: number;
      radius?: number;
    }
  | {
      kind: 'text';
      x: number;
      /** The middle of the line, not its baseline: every caller knows a row. */
      y: number;
      text: string;
      fill: string;
      size: number;
      weight?: number;
      align?: 'left' | 'center' | 'right';
      /** Condensed rather than clipped when it will not fit, as canvas does. */
      maxWidth?: number;
      tracking?: number;
      mono?: boolean;
    }
  | {
      kind: 'piece';
      x: number;
      y: number;
      size: number;
      color: SideColor;
      piece: PlayablePiece;
    };

export interface ShareCardPlan {
  width: number;
  height: number;
  background: string;
  shapes: CardShape[];
}

/** One side, as a band names them. */
export interface CardPlayer {
  name: string;
  /** The dim second line: a rating, a bot's level, "you". */
  detail?: string;
}

/**
 * Everything the card can say about the board beyond the board itself.
 *
 * All optional, and the modal only offers a switch for what is actually here —
 * an analysis board has no players and no clock, and a panel offering to draw
 * them would be offering nothing.
 */
export interface ShareCardDetail {
  players?: Record<SideColor, CardPlayer> | null;
  /** Milliseconds left, per side. */
  clock?: Record<SideColor, number> | null;
  /** What each side has *taken*, which is the tray drawn beside their name. */
  captured?: Record<SideColor, PieceTally> | null;
  /** Over the board, after the mode's name: `RANKED`, `GAME 3 OF 6`. */
  heading?: string | null;
  /** Under the board: `Blue to move · move 14`, or how the game ended. */
  caption?: string | null;
  /** The host to sign the picture with. Absent leaves it unsigned. */
  site?: string | null;
}

/** Which extras are drawn. Every one of them is a switch in the export modal. */
export interface ShareCardOptions {
  names: boolean;
  clocks: boolean;
  captures: boolean;
  coordinates: boolean;
  lastMove: boolean;
  labels: boolean;
}

export const DEFAULT_SHARE_OPTIONS: ShareCardOptions = {
  names: true,
  clocks: true,
  captures: true,
  coordinates: true,
  lastMove: true,
  labels: true,
};

export interface ShareCardInput {
  grid: Grid;
  currentTurn: PlayerColor;
  mode: ModeDefinition;
  era?: RulesEra;
  /** Drawn from Red's side, the way the screen turns the board round for Red. */
  flipped?: boolean;
  lastMove?: Move | null;
  detail?: ShareCardDetail;
  options?: Partial<ShareCardOptions>;
}

const shapeOf = (grid: Grid) => ({ columns: grid[0]?.length ?? 0, rows: grid.length });

/**
 * A clock as the player bar spells it — `4:58`, and tenths under twenty
 * seconds, which is when a tenth is the difference between two games.
 *
 * A copy of `PlayerBar`'s rather than a shared helper on purpose: that one is
 * fed by a ticking hook and this one by a number that has already stopped, and
 * the day they are allowed to differ is the day one of them animates.
 */
const formatClock = (milliseconds: number) => {
  const safe = Math.max(0, milliseconds);
  if (safe < 20_000) {
    const seconds = Math.floor(safe / 1000);
    return `0:${String(seconds).padStart(2, '0')}.${Math.floor((safe % 1000) / 100)}`;
  }
  const totalSeconds = Math.ceil(safe / 1000);
  return `${Math.floor(totalSeconds / 60)}:${String(totalSeconds % 60).padStart(2, '0')}`;
};

/** How many pieces a tray holds, which is whether it is worth offering at all. */
export const trayCount = (tally: PieceTally | null | undefined) =>
  PLAYABLE_PIECES.reduce((total, piece) => total + (tally?.[piece] ?? 0), 0);

/** How wide a tray of these pieces will be, so the name beside it can be given the rest. */
const trayWidth = (tally: PieceTally | undefined) => {
  const groups = PLAYABLE_PIECES.filter((piece) => (tally?.[piece] ?? 0) > 0);
  if (groups.length === 0) return 0;
  const pieces = groups.reduce((total, piece) => {
    const count = tally?.[piece] ?? 0;
    return total + TRAY_PIECE * (1 + (count - 1) * (1 - TRAY_OVERLAP));
  }, 0);
  return pieces + (groups.length - 1) * 4;
};

/** Where a square is drawn, which is not where it is: Red sees the board turned. */
const displayPosition = (
  x: number,
  y: number,
  flipped: boolean,
  columns: number,
  rows: number,
) => ({
  column: flipped ? columns - 1 - x : x,
  row: flipped ? y : rows - 1 - y,
});

const drawBoard = (
  shapes: CardShape[],
  { grid, mode, era, flipped, lastMove, options, left, top }: {
    grid: Grid;
    mode: ModeDefinition;
    era: RulesEra;
    flipped: boolean;
    lastMove: Move | null;
    options: ShareCardOptions;
    left: number;
    top: number;
  },
) => {
  const shape = shapeOf(grid);
  const boardWidth = shape.columns * TILE;
  const boardHeight = shape.rows * TILE;

  shapes.push({
    kind: 'rect',
    x: left,
    y: top,
    width: boardWidth + FRAME * 2,
    height: boardHeight + FRAME * 2,
    fill: boardTheme.frame,
    radius: 10,
  });

  for (const row of grid) {
    for (const tile of row) {
      const at = displayPosition(tile.x, tile.y, flipped, shape.columns, shape.rows);
      const x = left + FRAME + at.column * TILE;
      const y = top + FRAME + at.row * TILE;
      const light = (tile.x + tile.y) % 2 === 0;
      shapes.push({
        kind: 'rect',
        x,
        y,
        width: TILE,
        height: TILE,
        fill: light ? boardTheme.lightTile : boardTheme.darkTile,
      });

      const tint = tintForTile(mode.id, tile, shape, era);
      if (tint && (tint.color === 'Red' || tint.color === 'Blue')) {
        const palette = players[tint.color];
        shapes.push({
          kind: 'rect',
          x,
          y,
          width: TILE,
          height: TILE,
          fill: palette.tint,
          stroke: tint.kind === 'goal' ? boardTheme.goalOutline : palette.tintBorder,
          strokeWidth: 1,
        });
        // The mark, in the shapes `TileMark` draws: a goal wears two rails at
        // the end of the board it is won from, territory a pair of corners on
        // the same edge. Both hug the owner's own end, and rank 1 is Blue's.
        const ownEdgeIsBottom = (tint.color === 'Blue') !== flipped;
        if (tint.kind === 'goal') {
          for (const offset of [3, 6]) {
            shapes.push({
              kind: 'rect',
              x: x + TILE * 0.19,
              y: ownEdgeIsBottom ? y + TILE - offset - 1.5 : y + offset,
              width: TILE * 0.62,
              height: 1.5,
              fill: palette.territoryMark,
              radius: 1,
            });
          }
        } else {
          // Two corner brackets, each an L of two bars rather than an outlined
          // square: `TileMark` draws corners, and a closed box on eighteen
          // tiles reads as eighteen empty checkboxes rather than as a corner.
          const arm = TILE * 0.19;
          const bar = 1.5;
          const markY = ownEdgeIsBottom ? y + TILE - 2 - bar : y + 2;
          const armY = ownEdgeIsBottom ? y + TILE - 2 - arm : y + 2;
          for (const left of [true, false]) {
            const markX = left ? x + 2 : x + TILE - 2 - arm;
            shapes.push({
              kind: 'rect',
              x: markX,
              y: markY,
              width: arm,
              height: bar,
              fill: palette.territoryMark,
              radius: 1,
            });
            shapes.push({
              kind: 'rect',
              x: left ? x + 2 : x + TILE - 2 - bar,
              y: armY,
              width: bar,
              height: arm,
              fill: palette.territoryMark,
              radius: 1,
            });
          }
        }
      }

      if (options.lastMove && lastMove) {
        const isFrom = lastMove.from.x === tile.x && lastMove.from.y === tile.y;
        const isTo = lastMove.to.x === tile.x && lastMove.to.y === tile.y;
        if (isFrom || isTo) {
          shapes.push({
            kind: 'rect',
            x,
            y,
            width: TILE,
            height: TILE,
            fill: isFrom ? boardTheme.lastMoveFrom : boardTheme.lastMoveTo,
          });
          shapes.push({
            kind: 'rect',
            x: x + 3,
            y: y + 3,
            width: TILE - 6,
            height: TILE - 6,
            stroke: boardTheme.lastMoveMark,
            strokeWidth: isTo ? 2 : 1.5,
            radius: 2,
          });
        }
      }

      if (options.coordinates) {
        if (at.column === 0) {
          shapes.push({
            kind: 'text',
            x: x + 4,
            y: y + 8,
            text: String(tile.y + 1),
            fill: light ? boardTheme.labelOnLight : boardTheme.labelOnDark,
            size: 9,
            weight: 900,
          });
        }
        if (at.row === shape.rows - 1) {
          shapes.push({
            kind: 'text',
            x: x + TILE - 4,
            y: y + TILE - 8,
            text: FILES[tile.x] ?? '?',
            fill: light ? boardTheme.labelOnLight : boardTheme.labelOnDark,
            size: 9,
            weight: 900,
            align: 'right',
          });
        }
      }

      if (tile.occupant !== 'Empty' && tile.occupantOwner !== 'Neutral') {
        const size = TILE * 0.78;
        shapes.push({
          kind: 'piece',
          x: x + (TILE - size) / 2,
          y: y + (TILE - size) / 2,
          size,
          color: tile.occupantOwner,
          piece: tile.occupant,
        });
      }
    }
  }

  return { width: boardWidth + FRAME * 2, height: boardHeight + FRAME * 2 };
};

const drawBand = (
  shapes: CardShape[],
  { side, player, clockMs, tally, active, options, left, top, width }: {
    side: SideColor;
    player: CardPlayer | null;
    clockMs: number | null;
    tally: PieceTally | null;
    active: boolean;
    options: ShareCardOptions;
    left: number;
    top: number;
    width: number;
  },
) => {
  const palette = players[side];
  const middle = top + BAND_HEIGHT / 2;
  shapes.push({
    kind: 'rect',
    x: left,
    y: top,
    width,
    height: BAND_HEIGHT,
    fill: colors.surfaceRaised,
    stroke: active ? palette.border : colors.border,
    strokeWidth: 1,
    radius: 9,
  });

  // The side's own square, the way a player bar wears one. It is what says
  // whose band this is when the names are switched off, so it is not optional.
  shapes.push({
    kind: 'rect',
    x: left + 10,
    y: middle - MONOGRAM / 2,
    width: MONOGRAM,
    height: MONOGRAM,
    fill: palette.surface,
    stroke: palette.border,
    strokeWidth: 1,
    radius: 7,
  });
  shapes.push({
    kind: 'text',
    x: left + 10 + MONOGRAM / 2,
    y: middle,
    text: side.charAt(0),
    fill: palette.strong,
    size: 13,
    weight: 900,
    align: 'center',
  });

  let rightEdge = left + width - 12;
  if (options.clocks && clockMs !== null) {
    const chipLeft = rightEdge - CLOCK_WIDTH;
    shapes.push({
      kind: 'rect',
      x: chipLeft,
      y: middle - CLOCK_HEIGHT / 2,
      width: CLOCK_WIDTH,
      height: CLOCK_HEIGHT,
      fill: active ? clockTheme.activeSurface : clockTheme.idleSurface,
      radius: 7,
    });
    shapes.push({
      kind: 'text',
      x: chipLeft + CLOCK_WIDTH / 2,
      y: middle,
      text: formatClock(clockMs),
      fill: active ? clockTheme.activeText : clockTheme.idleText,
      size: 14,
      weight: 800,
      align: 'center',
      mono: true,
    });
    rightEdge = chipLeft - 10;
  }

  if (options.captures && tally) {
    // Drawn right to left from wherever the clock left off, so the tray always
    // ends against the same edge however much of it there is.
    const taken = opposingColor(side);
    let x = rightEdge - trayWidth(tally);
    for (const piece of PLAYABLE_PIECES) {
      const count = tally[piece] ?? 0;
      if (count <= 0) continue;
      for (let index = 0; index < count; index += 1) {
        shapes.push({
          kind: 'piece',
          x: x + index * TRAY_PIECE * (1 - TRAY_OVERLAP),
          y: middle - TRAY_PIECE / 2,
          size: TRAY_PIECE,
          color: taken,
          piece,
        });
      }
      x += TRAY_PIECE * (1 + (count - 1) * (1 - TRAY_OVERLAP)) + 4;
    }
    rightEdge -= trayWidth(tally) === 0 ? 0 : trayWidth(tally) + 10;
  }

  if (options.names && player) {
    const textLeft = left + 10 + MONOGRAM + 9;
    const room = Math.max(40, rightEdge - textLeft);
    shapes.push({
      kind: 'text',
      x: textLeft,
      y: player.detail ? middle - 7 : middle,
      text: player.name,
      fill: colors.textStrong,
      size: 14,
      weight: 800,
      maxWidth: room,
    });
    if (player.detail) {
      shapes.push({
        kind: 'text',
        x: textLeft,
        y: middle + 10,
        text: player.detail,
        fill: colors.textFaint,
        size: 10,
        weight: 700,
        maxWidth: room,
      });
    }
  }
};

/**
 * Lay the card out.
 *
 * The stack is the board's own column on screen — the far side's band, the
 * board, your band — because somebody looking at the picture should recognise
 * the screen it came off. Everything above and below that is a label, and every
 * band and label disappears cleanly: with all six switches off this returns a
 * board on a background and nothing else, at exactly the board's size.
 */
export const buildShareCard = ({
  grid,
  currentTurn,
  mode,
  era = 'current',
  flipped = false,
  lastMove = null,
  detail = {},
  options: requested = {},
}: ShareCardInput): ShareCardPlan => {
  const options = { ...DEFAULT_SHARE_OPTIONS, ...requested };
  const shape = shapeOf(grid);
  const boardBox = {
    width: shape.columns * TILE + FRAME * 2,
    height: shape.rows * TILE + FRAME * 2,
  };

  // A band is worth drawing when it would carry something. Switching the names,
  // the clocks and the trays all off is switching the bands off, which is the
  // behaviour that lets one set of checkboxes mean what it says rather than
  // leaving two empty strips behind.
  const bandCarries = (side: SideColor) =>
    (options.names && Boolean(detail.players?.[side])) ||
    (options.clocks && typeof detail.clock?.[side] === 'number') ||
    (options.captures && trayWidth(detail.captured?.[side]) > 0);
  const bands = bandCarries('Red') || bandCarries('Blue');
  const labels = options.labels && Boolean(detail.caption || detail.site || mode.name);

  const contentWidth = Math.max(boardBox.width, bands ? MINIMUM_BAND_WIDTH : 0);
  const width = contentWidth + PAD * 2;
  const boardLeft = PAD + (contentWidth - boardBox.width) / 2;

  const shapes: CardShape[] = [];
  let y = PAD;

  if (labels) {
    shapes.push({
      kind: 'text',
      x: PAD,
      y: y + HEADING_HEIGHT / 2,
      text: [mode.name, detail.heading].filter(Boolean).join(' · ').toUpperCase(),
      fill: colors.accentBright,
      size: 12,
      weight: 900,
      tracking: 1.2,
      maxWidth: contentWidth * 0.62,
    });
    shapes.push({
      kind: 'text',
      x: PAD + contentWidth,
      y: y + HEADING_HEIGHT / 2,
      text: 'RPS STRATEGY',
      fill: colors.textFaint,
      size: 11,
      weight: 900,
      tracking: 1.6,
      align: 'right',
    });
    y += HEADING_HEIGHT + GAP;
  }

  // The board is turned round for Red, so the band on top is whichever side is
  // playing away from the viewer — the same swap `GameScreen` makes.
  const topSide: SideColor = flipped ? 'Blue' : 'Red';
  const bottomSide = opposingColor(topSide);
  const bandFor = (side: SideColor) => ({
    side,
    player: detail.players?.[side] ?? null,
    clockMs: typeof detail.clock?.[side] === 'number' ? detail.clock[side] : null,
    tally: detail.captured?.[side] ?? null,
    active: currentTurn === side,
    options,
    left: PAD,
    width: contentWidth,
  });

  if (bands) {
    drawBand(shapes, { ...bandFor(topSide), top: y });
    y += BAND_HEIGHT + BOARD_GAP;
  }

  drawBoard(shapes, {
    grid,
    mode,
    era,
    flipped,
    lastMove,
    options,
    left: boardLeft,
    top: y,
  });
  y += boardBox.height;

  if (bands) {
    y += BOARD_GAP;
    drawBand(shapes, { ...bandFor(bottomSide), top: y });
    y += BAND_HEIGHT;
  }

  if (labels) {
    y += GAP;
    if (detail.caption) {
      shapes.push({
        kind: 'text',
        x: PAD,
        y: y + FOOTER_HEIGHT / 2,
        text: detail.caption,
        fill: colors.textMuted,
        size: 12,
        weight: 700,
        maxWidth: contentWidth * 0.66,
      });
    }
    if (detail.site) {
      shapes.push({
        kind: 'text',
        x: PAD + contentWidth,
        y: y + FOOTER_HEIGHT / 2,
        text: detail.site,
        fill: colors.textFaint,
        size: 11,
        weight: 700,
        align: 'right',
      });
    }
    y += FOOTER_HEIGHT;
  }

  return { width, height: y + PAD, background: colors.background, shapes };
};
