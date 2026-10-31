import { countUpSchedule, type CountUpStep } from '@/haptics/recipes';
import type { RatingUpdate } from '@/types/protocol';
import type { Grid, PlayerColor, SideColor } from '@/types/game';

// The finished card's two counts: what the game came to, then what it did to
// the player's rating.
//
// Both are counted out rather than printed, one tap per step, because a result
// is the moment a player most wants to *feel* the game add up — the pieces
// they took arriving one at a time, the rating climbing to where it ends. The
// tally comes first because it is what happened; the rating after, because it
// is what that was worth.
//
// Pure, and apart from the card, so the timing can be tested: the card only
// draws whatever value the plan says it has reached.

/** How long the card stands still before counting, so the result is read first. */
export const COUNT_START_MS = 400;

/** The breath between the tally landing and the rating setting off. */
export const COUNT_GAP_MS = 180;

const TALLY_SPAN_MS = 700;
const RATING_SPAN_MS = 600;

/** A rating as it was before the game and as the game left it. */
export interface RatingChange {
  before: number;
  after: number;
}

export interface FinishCountPlan {
  /** Steps of the tally, timed from the card's first frame. */
  tally: CountUpStep[];
  /** Steps of the rating, after the tally. */
  rating: CountUpStep[];
}

export const finishCountPlan = ({
  tally,
  rating,
}: {
  tally: number;
  rating: RatingChange | null;
}): FinishCountPlan => {
  const tallySteps = countUpSchedule(0, tally, { maxSpanMs: TALLY_SPAN_MS }).map((step) => ({
    ...step,
    atMs: COUNT_START_MS + step.atMs,
  }));
  const ratingStart = tallySteps.length
    ? tallySteps[tallySteps.length - 1]!.atMs + COUNT_GAP_MS
    : COUNT_START_MS;
  const ratingSteps = rating
    ? countUpSchedule(rating.before, rating.after, { maxSpanMs: RATING_SPAN_MS }).map(
        (step) => ({ ...step, atMs: ratingStart + step.atMs }),
      )
    : [];
  return { tally: tallySteps, rating: ratingSteps };
};

/**
 * This player's rating change, from the update the server sent with the final
 * position — or null when there is nothing to count: a casual game, one that
 * was not recorded, an update belonging to some other game, or a reader who
 * was not playing.
 */
export const ratingChangeFor = (
  update: (RatingUpdate & { gameId: string }) | null | undefined,
  gameId: string,
  playerColor: PlayerColor | null,
): RatingChange | null => {
  if (!update || update.gameId !== gameId || !update.ranked || !update.recorded) return null;
  if (playerColor === 'Red') {
    return { before: Math.round(update.redEloBefore), after: Math.round(update.redEloAfter) };
  }
  if (playerColor === 'Blue') {
    return { before: Math.round(update.blueEloBefore), after: Math.round(update.blueEloAfter) };
  }
  return null;
};

/** How many squares each side owns: Total War's score. */
export const ownedSquares = (grid: Grid): Record<SideColor, number> =>
  grid.flat().reduce(
    (counts, tile) => {
      if (tile.ownerColor === 'Red' || tile.ownerColor === 'Blue') counts[tile.ownerColor] += 1;
      return counts;
    },
    { Red: 0, Blue: 0 },
  );

/**
 * Whose side a count starts from: the reader's own, or Blue's at a shared
 * board, where Blue moved first.
 */
export const tallySides = (playerColor: PlayerColor | null): [SideColor, SideColor] =>
  playerColor === 'Red' ? ['Red', 'Blue'] : ['Blue', 'Red'];
