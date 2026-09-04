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

/** Whose games these are. */
export type OpeningCohort = 'human' | 'bot' | 'mixed';

/** One line, and what happened in the games that played it. */
export interface OpeningStatsLine {
  line: OpeningLine;
  /** The last move of `line`, so a row can be labelled without diffing. */
  move?: string;
  games: number;
  /** Share of the cohort's games that played this line, 0 to 1. */
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
  cohort: OpeningCohort;
  /** The denominator: how many of this cohort's games were counted. */
  games: number;
  /**
   * How many of the mode's archived games could not be counted.
   *
   * Not a footnote. The rules changed on 2026-09-03 so that Blue moves first,
   * and a game recorded before that does not replay under today's rules -- so
   * this is most of the archive, and a page that showed the counted games
   * without saying how many were dropped would mislead by omission.
   */
  skipped: number;
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
 */
export const openingScoreline = (
  line: OpeningStatsLine,
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
 * sign, and the page shows the count instead. With the archive as thin as the
 * rules change left it, most lines are below this.
 */
export const SHARE_IS_MEANINGFUL_AT = 10;

export const hasEnoughGames = (games: number) => games >= SHARE_IS_MEANINGFUL_AT;
