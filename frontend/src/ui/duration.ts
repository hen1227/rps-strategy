// How long something has been going on, in days.
//
// Days rather than the "3d ago" shape the two `relativeTime` helpers use, and
// deliberately not a fourth copy of those: they answer "when did this happen",
// and this answers "how long has this been true". A reign of four hundred days
// reading "400 days" is the whole point of the feature it was written for —
// the question is how dominant an engine has been, and rounding that to "1y"
// throws the answer away to save four characters.
//
// Shared rather than local to one screen because the ladder and a bot's page
// both draw the same reign, and two roundings of one number would let the two
// disagree about it on the same afternoon.

const DAY = 24 * 60 * 60 * 1000;

/**
 * Whole days between two instants, never negative.
 *
 * Clamped at zero because clocks disagree: these timestamps are the server's
 * and `now` is the reader's device, so a reign recorded seconds ago can arrive
 * looking very slightly like the future.
 */
export const daysBetween = (fromUnixMs: number, toUnixMs: number): number =>
  Math.max(0, Math.floor((toUnixMs - fromUnixMs) / DAY));

/**
 * A span of days, spelled for a sentence like "#1 for 24 days".
 *
 * The first day is "today" rather than "0 days", which is true and reads as a
 * bug.
 */
export const formatDays = (days: number): string => {
  if (days < 1) return 'today';
  if (days === 1) return '1 day';
  return `${days} days`;
};

/** `formatDays(daysBetween(...))`, which is how both callers use it. */
export const formatSpan = (fromUnixMs: number, toUnixMs: number): string =>
  formatDays(daysBetween(fromUnixMs, toUnixMs));
