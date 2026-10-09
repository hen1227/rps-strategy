/**
 * Ratings, as the client needs to talk about them.
 *
 * The system itself is the backend's persistence/rating.go: Glicko-2 on the
 * familiar 1500 scale, with the number on screen set one deviation under the
 * strength. Everybody starts at RATING_START and climbs as they play, because
 * every game narrows the deviation. The server decides how far a number can be
 * trusted and says so in `ratingState`; this file is the one place that turns
 * that into something to draw, so the ladder, a profile and the lobby cannot
 * each invent their own phrasing for it.
 */

import type { ModeID } from '@/types/game';
import type { ModeRating, RatingState } from '@/types/protocol';

/** The rating of somebody with no ranked game in a mode. */
export const RATING_START = 1150;

/** The words for a rating that is not one yet. */
export const RATING_UNRATED_LABEL = 'No ranked games yet';

/** The same thing where there is only room for a number. */
export const RATING_UNRATED_SHORT = '–';

/** Said of a number that is still climbing towards its owner's strength. */
export const RATING_PROVISIONAL_LABEL = 'Provisional';

/**
 * The name today's system goes by in a stored game.
 *
 * The same string the server writes into a record's `RatingSystem` tag — see
 * notation/pgn.go — and the reason the tag exists: the ratings in an archived
 * game were written on whichever scale was current when it was played, and
 * every scale this site has used produces numbers that look like ratings.
 */
export const RATING_SYSTEM = 'glicko2/1';

/** The scale before this one, where 1 was an engine playing at random. */
export const ANCHORED_RATING_SYSTEM = 'anchored/1';

/**
 * What to say beneath a rating read out of an archived game.
 *
 * The record's own `ratingSystem` tag goes in, so an old game says so where it
 * is shown rather than passing its number off as one of today's. There is
 * always something to say here, unlike `ratingCaveat` below: a rating in a
 * record is a rating *as of then* even when the scale has not moved. A record
 * with no tag at all predates both later scales and is chess Elo centred on
 * 1200.
 */
export const archivedRatingCaveat = (ratingSystem: string | null): string => {
  if (ratingSystem === RATING_SYSTEM) return 'Ratings at the time of this game.';
  if (ratingSystem === ANCHORED_RATING_SYSTEM) {
    return (
      'Ratings as they stood for this game, on an earlier scale where 1 meant ' +
      "playing at random. They cannot be compared with today's."
    );
  }
  return (
    'Ratings as they stood for this game, on the old 1200-centred scale. ' +
    "They cannot be compared with today's."
  );
};

/**
 * Whether a row's number should be shown at all.
 *
 * An absent state is treated as a real rating, deliberately: a server older than
 * the field has no way to say otherwise, and blanking every rating on it would
 * be a worse failure than showing a number that has not been earned yet.
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

/** One rating standing for an account: the number, how far to trust it, and its mode. */
export interface HeadlineRating {
  elo: number;
  state: RatingState;
  modeId: ModeID | null;
}

/**
 * The rating that stands for an account as a whole: its best rated mode.
 *
 * The same choice the server makes for `account.elo` and the combined board,
 * read off the modes so the state comes with it. An account with no ranked game
 * anywhere is unrated, at the number everybody starts on.
 */
export function headlineRating(
  modeRatings: Partial<Record<ModeID, ModeRating>> | undefined,
): HeadlineRating {
  let best: HeadlineRating = { elo: RATING_START, state: 'unrated', modeId: null };
  for (const rating of Object.values(modeRatings ?? {})) {
    if (!rating || !ratingIsRankable(rating.ratingState)) continue;
    if (best.state === 'unrated' || rating.elo > best.elo) {
      best = { elo: rating.elo, state: rating.ratingState ?? 'rated', modeId: rating.modeId };
    }
  }
  return best;
}
