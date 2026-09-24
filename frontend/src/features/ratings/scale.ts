/**
 * The rating scale, as the client needs to talk about it.
 *
 * Every number here is also a constant in the backend's rating_scale.go, and
 * the server serves them on /api/ladder-pool so a client can check rather than
 * assume. They are duplicated rather than fetched because a leaderboard row
 * cannot wait on a request to know how to label itself, and because the two
 * would have to agree anyway — a scale the client and the server disagree about
 * is worse than either of them.
 */

import type { RatingState } from '@/types/protocol';

/** The lowest rating there is: an opponent that plays a random legal move. */
export const RATING_FLOOR = 1;

/** Points per doubling of the odds of winning. */
export const RATING_POINTS_PER_DOUBLING = 20;

/**
 * One sentence, for anywhere a rating needs explaining.
 *
 * True of a person's rating always, and of an engine's only while the server's
 * reference engines are standing. Without them the bot ladder measures from its
 * own weakest engine instead, so `1` means "the weakest engine on the board" —
 * see BOT_RELATIVE_SCALE_EXPLAINER, which the bot board shows in its place.
 */
export const RATING_EXPLAINER =
  `${RATING_FLOOR} means playing no better than chance. ` +
  `Every ${RATING_POINTS_PER_DOUBLING} points doubles your odds of winning.`;

/**
 * What the bot board means while nothing is designated.
 *
 * The doubling half is unchanged — a gap is a gap however the zero was chosen —
 * and only the floor's meaning moves. Worth saying rather than quietly printing
 * the sentence above, because the two readings of `1` look identical and one of
 * them is a claim the board cannot currently support.
 */
export const BOT_RELATIVE_SCALE_EXPLAINER =
  `${RATING_FLOOR} is the weakest engine on this board, and every ` +
  `${RATING_POINTS_PER_DOUBLING} points doubles the odds of winning. ` +
  `Engines are compared with each other, so the floor moves as the field does.`;

/**
 * The model's chance that one rating beats another, ignoring colour and draws.
 *
 * Worth having on the client because it turns a pair of numbers into the thing
 * people actually want from them: "you are a 3-to-1 favourite" reads, and "you
 * are 32 points ahead" does not until you already know the scale.
 */
export function ratingWinChance(rating: number, against: number): number {
  const gap = (against - rating) / RATING_POINTS_PER_DOUBLING;
  return 1 / (1 + Math.pow(2, gap));
}

/** How the odds between two ratings read out loud, e.g. "3 to 1". */
export function ratingOdds(rating: number, against: number): string {
  const chance = ratingWinChance(rating, against);
  const stronger = Math.max(chance, 1 - chance);
  const ratio = stronger / (1 - stronger);
  if (ratio < 1.1) return 'even';
  return `${ratio.toFixed(ratio < 10 ? 1 : 0)} to 1`;
}

/**
 * The words for a rating that is not one.
 *
 * `1` is a real measurement on this scale — it means playing no better than
 * chance — so it cannot also stand for "we have not measured this". The server
 * decides which of the two a row is and says so in `ratingState`; this is the
 * one place that turns that into something to draw, so the ladder, a profile and
 * the lobby cannot each invent their own phrasing for it.
 */
export const RATING_UNRATED_LABEL = 'Not enough data to rank';

/** The same thing where there is only room for a number. */
export const RATING_UNRATED_SHORT = '–';

/** Said of a number the shrinkage is still visibly holding back. */
export const RATING_PROVISIONAL_LABEL = 'Provisional';

/**
 * The name today's scale goes by in a stored game.
 *
 * The same string the server writes into a record's `RatingSystem` tag — see
 * notation/pgn.go — and the reason the tag exists: the ratings in an archived
 * game were written on whichever scale was current when it was played, and a
 * game from before the rebuild carries chess Elo centred on 1200. Both produce
 * four-, three- and two-figure numbers that look exactly like ratings, so a
 * reader with no tag to go on cannot tell which scale a number is on, and
 * averaging or comparing across the two gives an answer that means nothing.
 */
export const RATING_SYSTEM = 'anchored/1';

/**
 * What to say beneath a rating read out of an archived game.
 *
 * The record's own `ratingSystem` tag goes in, so an old game says so where it
 * is shown rather than passing its number off as one of today's. There is
 * always something to say here, unlike `ratingCaveat` above: a rating in a
 * record is a rating *as of then* even when the scale has not moved, which is
 * the thing a reader of a two-year-old game most needs telling.
 */
export const archivedRatingCaveat = (ratingSystem: string | null): string =>
  ratingSystem === RATING_SYSTEM
    ? "Ratings at the time of this game."
    : 'Ratings as they stood for this game, on the old 1200-centred scale. ' +
      "They cannot be compared with today's.";

/**
 * Whether a row's number should be shown at all.
 *
 * An absent state is treated as a real rating, deliberately: a server older than
 * the field has no way to say otherwise, and blanking every rating on it would
 * be a worse failure than the ambiguity this whole idea replaces.
 */
export const ratingIsRankable = (state?: RatingState): boolean => state !== 'unrated';

/** What to print where a rating goes. */
export const ratingLabel = (elo: number, state?: RatingState): string =>
  ratingIsRankable(state) ? String(elo) : RATING_UNRATED_SHORT;

/**
 * The sentence a screen with room for one should show beneath a rating, or null
 * when the number speaks for itself.
 */
export const ratingCaveat = (state?: RatingState): string | null => {
  if (state === 'unrated') return RATING_UNRATED_LABEL;
  if (state === 'provisional') return `${RATING_PROVISIONAL_LABEL} · still settling`;
  return null;
};
