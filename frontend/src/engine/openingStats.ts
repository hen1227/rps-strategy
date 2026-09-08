/**
 * What people actually play.
 *
 * The opening book says what is good; this says what happens. They are
 * different kinds of claim and the page keeps them apart -- a move can be the
 * engine's third choice and the one four players in five reach for, and that
 * gap is the interesting part rather than a discrepancy to reconcile.
 *
 * Compiled from the game archive by the server once a day. Nothing here
 * computes a share: the server divides by a total it knows, so a number on
 * screen cannot disagree with the count printed beside it.
 */

import type { OpeningLine } from './openingBook';

/**
 * Where a game came from and who played it.
 *
 * The four partition every game exactly once, which is what lets the explorer
 * offer them as checkboxes: tick any set and the server adds the counts up, and
 * no game is counted twice because no game is in two segments.
 *
 * - `human`, `bot`, `mixed` -- this site's own archive, by who sat down.
 * - `meaf` -- the meaf.us archive, bulk human play from a different server.
 *
 * Adding a source is adding a name here and a checkbox in the explorer; the
 * server takes whatever set it is handed.
 */
export type OpeningSegment = 'human' | 'bot' | 'mixed' | 'meaf';

/** One line, and what happened in the games that played it. */
export interface OpeningStatsLine {
  line: OpeningLine;
  /** The last move of `line`, so a row can be labelled without diffing. */
  move?: string;
  games: number;
  /** Share of the selected sources' games that played this line, 0 to 1. */
  share: number;
  /** Share of the games that reached the previous position and played this. */
  shareOfParent: number;
  redWins: number;
  blueWins: number;
  draws: number;
  lastPlayedUnixMs: number;
}

/** One position's statistics, and the mode's totals behind them. */
export interface OpeningStatsNode {
  modeId: string;
  /** The sources these numbers were added up from. */
  segments: OpeningSegment[];
  /** The denominator: how many games in those sources were counted. */
  games: number;
  /**
   * How many of the mode's games in these sources could not be counted.
   *
   * Not a footnote: a page that showed the counted games without saying how
   * many were dropped would mislead by omission.
   */
  skipped: number;
  /**
   * How many of `games` were counted through the pre-change reading.
   *
   * The rules changed on 2026-09-03: Blue moves first now, and Intransitive's
   * board was flipped end for end. A game recorded before that opens with a
   * Red move and does not replay as written. Reversing the ranks and swapping
   * the colours makes it the same opening played by the side that opens
   * today, which is what the server counts -- and this is how many of the
   * numbers on screen were read that way. Most of the archive, until the
   * archive turns over.
   */
  turned: number;
  /** How many plies deep the compile went. */
  plies: number;
  computedAtUnixMs: number;
  line: OpeningLine;
  /** This line's own counts; absent at the starting position. */
  position?: OpeningStatsLine;
  /** The moves played from here, most played first. */
  continuations: OpeningStatsLine[];
  /** The mode's most played lines, most played first. */
  popular?: OpeningStatsLine[];
}

/**
 * A share as a percentage, at the precision the number can carry.
 *
 * One decimal place below 10% and none above, because a share is a sample: at
 * a hundred games "38.4%" claims a resolution the sample does not have, while
 * "0.9%" and "1%" are genuinely different-looking rows.
 */
export const formatShare = (share: number): string => {
  const percent = share * 100;
  if (!Number.isFinite(percent) || percent <= 0) return '0%';
  if (percent < 10) return `${percent.toFixed(1)}%`;
  return `${Math.round(percent)}%`;
};

/**
 * How a line's games turned out, from Red's side.
 *
 * Returns null when nothing decisive happened, so a caller can leave the bar
 * out rather than draw an empty one.
 *
 * Asks for the three counts rather than a whole statistics row, because both
 * shapes on these screens carry them and neither is a subtype of the other: a
 * line has a path, a position has a ply.
 */
export const openingScoreline = (
  line: { redWins: number; blueWins: number; draws: number },
): { redShare: number; blueShare: number; drawShare: number } | null => {
  const decided = line.redWins + line.blueWins + line.draws;
  if (decided <= 0) return null;
  return {
    redShare: line.redWins / decided,
    blueShare: line.blueWins / decided,
    drawShare: line.draws / decided,
  };
};

/**
 * Whether a sample is worth quoting a percentage from.
 *
 * Ten games is not a statistical threshold and is not presented as one -- it
 * is the point below which a share is really just a count wearing a percent
 * sign, and the page shows the count instead. Past the first move or two most
 * lines are below this, because a few hundred games spread over a nine by
 * nine board stop repeating each other quickly.
 */
export const SHARE_IS_MEANINGFUL_AT = 10;

export const hasEnoughGames = (games: number) => games >= SHARE_IS_MEANINGFUL_AT;

// ---------------------------------------------------------------------------
// The explorer
// ---------------------------------------------------------------------------
//
// Keyed on the *board*, not on the moves that reached it. Two move orders
// arriving at the same picture are one position and one set of numbers, which
// is the question somebody standing on a board is asking -- and the one the
// line-keyed statistics above cannot answer, since a line is a path and
// deliberately counts those two as different openings.

/** One move played out of the board being looked at. */
export interface OpeningStatsExploredMove {
  /** How this move is written on the board in front of you. */
  move: string;
  /**
   * The other ways to write the same move on that board, absent for most moves.
   *
   * Not a second move and not a duplicate row. On a board that is its own
   * reflection — the Intransitive opening position, say — `e3-f3` and `c5-c6`
   * move different pieces to different squares and reach the *same position*,
   * so they are one continuation with one set of counts, and either can be
   * played. The board draws the first as an arrow and the rest as its dashed
   * twins in the same colour; two rows with the games split between them would
   * show a reader two half-sized moves that are the same move.
   */
  twins?: string[];
  games: number;
  /**
   * Of the games that *reached this board*, the share that played this move.
   * The conditional share is the explorer's number: "of the people who got
   * here, this is what they did".
   *
   * These can sum past 1, and it is not a fault: the denominator is games that
   * reached the board and the numerator is times it was left, so a game that
   * repeats a position contributes twice to the moves and once to the total.
   */
  share: number;
  /** The same count against every selected source, for how travelled this is. */
  shareOfAll: number;
  redWins: number;
  blueWins: number;
  draws: number;
}

/** One board, and what happened from it. */
export interface OpeningStatsExplored {
  modeId: string;
  segments: OpeningSegment[];
  /** The path the caller walked; a board can be reached several ways. */
  line: OpeningLine;
  /** How many moves in this board is, by the shortest route anybody took. */
  ply: number;
  /** Games that reached this board by any move order. Zero is a real answer. */
  games: number;
  share: number;
  redWins: number;
  blueWins: number;
  draws: number;
  /** Most played first. */
  moves: OpeningStatsExploredMove[];
  lastPlayedUnixMs: number;
  /** The selected sources’ total, what could not be counted, and what was turned. */
  skipped: number;
  turned: number;
  plies: number;
  computedAtUnixMs: number;
}

/**
 * How thick to draw a move's arrow, from its share of this board.
 *
 * Scaled against the *most played* move rather than against 1, so a board
 * where every continuation is rare still shows which of them is the common
 * one. A board with one move drawn at full weight is correct: it is the only
 * thing anybody did.
 */
export const arrowWeights = (
  moves: readonly OpeningStatsExploredMove[],
): number[] => {
  const top = moves.reduce((most, move) => Math.max(most, move.games), 0);
  if (top <= 0) return moves.map(() => 0);
  return moves.map((move) => move.games / top);
};
