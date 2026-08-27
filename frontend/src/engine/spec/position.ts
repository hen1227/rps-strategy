// The opening board, when nobody has drawn one.
//
// A mode's `startingPosition` is a rectangle of letters, and it is the one field
// of the rule language whose shape depends on two *other* fields: change the
// board's size or the list of kinds and the layout beside them is silently
// wrong. That is the commonest way a half-built mode stops being playable, and
// it is invisible from the rules — the validator says the layout is the wrong
// size, which is true and is not the interesting part.
//
// So this module knows what the default opening *is*, for any board and any set
// of kinds, and it knows how to carry an existing one across a change. Two jobs,
// and they answer the two things somebody designing a mode actually wants: "give
// me a sensible board to start from" and "keep my board when I widen this".
//
// `standardRows` is pinned to the shipped modes by test: a 9×9 board with Rock,
// Paper and Scissors on it must come back as exactly the layout Total War and
// Infiltration have always used. That is what makes it a *default* rather than
// an invention — the generalisation has to agree with the thing it generalises.

import { isBoardRows, type StartingPosition } from '@/types/game';
import type { RuleSpec } from './types';

/** An empty square, in every layout this project writes. */
const EMPTY = '.';

/**
 * How much of the board's width a side's opening block takes.
 *
 * A third, which is where the standard nine-wide board's three-wide block comes
 * from. Rounded up so a narrow board still has a block, and never wider than the
 * board itself.
 *
 * Then nudged to the board's own parity, because a block that cannot be centred
 * is a block that is one file off centre — and an opening one file off centre
 * hands somebody an advantage nobody chose and nobody would see. An eleven-wide
 * board therefore gets three files rather than four.
 */
const blockWidth = (width: number) => {
  const third = Math.max(1, Math.min(width, Math.ceil(width / 3)));
  if ((width - third) % 2 === 0) return third;
  return third > 1 ? third - 1 : Math.min(width, third + 1);
};

/** The same nudge, for a block that had to grow to fit the kinds standing on it. */
const centrable = (block: number, width: number) =>
  (width - block) % 2 === 0 || block >= width ? Math.min(block, width) : block + 1;

/**
 * The kinds standing on each rank, home rank first.
 *
 * The last kind declared stands on the home rank and the first stands furthest
 * forward, which is what the shipped modes do: `pieces` is `[Rock, Paper,
 * Scissors]` and Scissors is the back rank. A board with fewer ranks to spare
 * than there are kinds puts more than one kind on a rank rather than leaving a
 * kind off the board — a kind that never appears in the opening is a kind the
 * playtest can never exercise, which is worse than a crowded rank.
 */
const ranksOfKinds = (kinds: string[], height: number): string[][] => {
  const ranks = Math.max(1, Math.min(kinds.length, Math.floor(height / 2)));
  const rows: string[][] = Array.from({ length: ranks }, () => []);
  kinds.forEach((kind, index) => {
    // Spread the kinds over the ranks, then read them back from the home rank
    // outward, so the declaration order runs front to back.
    const rank = ranks - 1 - Math.floor((index * ranks) / kinds.length);
    rows[rank]?.push(kind);
  });
  return rows;
};

/**
 * One rank of a side's opening: its kinds, centred, sharing the block between
 * them.
 */
const rankRow = (kinds: string[], width: number): string => {
  if (kinds.length === 0) return EMPTY.repeat(width);
  const block = centrable(Math.max(blockWidth(width), kinds.length), width);
  const start = Math.floor((width - block) / 2);
  const squares = Array.from({ length: block }, (_unused, index) => {
    const which = Math.floor((index * kinds.length) / block);
    return kinds[which] ?? EMPTY;
  });
  return (
    EMPTY.repeat(start) + squares.join('') + EMPTY.repeat(width - start - block)
  );
};

/**
 * The default opening for a mode: both sides' kinds, massed and facing.
 *
 * Blue occupies the ranks nearest rank 1 and Red the ranks nearest rank *h*,
 * mirrored, because a symmetric opening is the only one that does not hand
 * somebody an advantage nobody chose. Upper case is Blue and lower case is Red,
 * the same convention every layout in this project is written with.
 */
export const standardRows = (spec: RuleSpec): string[] => {
  const { width, height } = spec.board;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    return [];
  }
  const symbols = spec.pieces.map((piece) => piece.symbol.toUpperCase());
  const blue = ranksOfKinds(symbols, height).map((kinds) => rankRow(kinds, width));
  return Array.from({ length: height }, (_unused, y) => {
    const fromTop = blue[y];
    if (fromTop !== undefined) return fromTop;
    const fromBottom = blue[height - 1 - y];
    if (fromBottom === undefined) return EMPTY.repeat(width);
    return fromBottom.toLowerCase();
  });
};

/** The default opening, as the field a spec carries. */
export const standardPosition = (spec: RuleSpec): StartingPosition => ({
  rows: standardRows(spec),
});

/**
 * An existing layout, carried onto a board of a different shape or a different
 * set of kinds.
 *
 * Width changes keep the layout centred, because that is where a default one
 * starts and where a hand-made one usually is; height changes keep each side's
 * ranks against their own home, so widening the gap between the armies inserts
 * empty ranks in the middle rather than shunting Red off the bottom. A letter
 * belonging to a kind that no longer exists becomes an empty square.
 *
 * Returns nothing when what survives is not a game — a layout whose kinds have
 * all gone, or one that leaves a side with no pieces and therefore no move — and
 * the caller should use `standardRows` instead. Distinguishing the two matters:
 * silently replacing a layout somebody wrote is worse than carrying it.
 */
export const fitRows = (rows: unknown, spec: RuleSpec): string[] | null => {
  if (!isBoardRows(rows)) return null;
  const { width, height } = spec.board;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    return null;
  }

  const allowed = new Set<string>();
  for (const piece of spec.pieces) {
    allowed.add(piece.symbol.toUpperCase());
    allowed.add(piece.symbol.toLowerCase());
  }

  const wasWidth = rows[0]?.length ?? 0;
  const wasHeight = rows.length;
  // Centring is the inverse of `rankRow`: the same offset on the way in and the
  // way out, so a default layout that is widened stays a default layout.
  const shift = Math.floor((width - wasWidth) / 2);
  // Ranks past the halfway line belong to the other side's home, so they are
  // measured from the far edge instead of the near one.
  const sourceRank = (y: number) => (y * 2 < height ? y : wasHeight - (height - y));

  let blue = 0;
  let red = 0;
  const built = Array.from({ length: height }, (_unused, y) => {
    const source = rows[sourceRank(y)];
    if (source === undefined) return EMPTY.repeat(width);
    return Array.from({ length: width }, (_unusedSquare, x) => {
      const symbol = source[x - shift];
      if (symbol === undefined || !allowed.has(symbol)) return EMPTY;
      if (symbol === symbol.toUpperCase()) blue += 1;
      else red += 1;
      return symbol;
    }).join('');
  });

  return blue > 0 && red > 0 ? built : null;
};

/**
 * The layout to use after `board` or `pieces` moved under it.
 *
 * What was there if any of it survives the move, and the default otherwise.
 */
export const refitRows = (rows: unknown, spec: RuleSpec): string[] =>
  fitRows(rows, spec) ?? standardRows(spec);

/** Whether a mode's opening is the default one for its board and its kinds. */
export const isStandardPosition = (spec: RuleSpec): boolean => {
  const rows = spec.startingPosition?.rows;
  if (!isBoardRows(rows)) return false;
  const standard = standardRows(spec);
  return rows.length === standard.length && rows.every((row, y) => row === standard[y]);
};

/**
 * Whether a layout fits the board and the kinds beside it.
 *
 * The same question the validator asks, asked without producing a report,
 * because the interesting caller — a patch deciding whether it has just broken
 * the opening — wants a yes or a no rather than a list of messages.
 */
export const positionFits = (spec: RuleSpec): boolean => {
  const rows = spec.startingPosition?.rows;
  if (!isBoardRows(rows)) return false;
  if (rows.length !== spec.board.height || rows[0]?.length !== spec.board.width) return false;
  const allowed = new Set<string>([EMPTY]);
  for (const piece of spec.pieces) {
    allowed.add(piece.symbol.toUpperCase());
    allowed.add(piece.symbol.toLowerCase());
  }
  return rows.every((row) => Array.from(row).every((symbol) => allowed.has(symbol)));
};

/** The opening in a phrase, for a tool result or a caption. */
export const describePosition = (spec: RuleSpec): string =>
  isStandardPosition(spec) ? 'the standard opening' : 'a custom opening';
