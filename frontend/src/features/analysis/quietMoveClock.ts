import { QUIET_PLY_LIMIT } from '@/engine/modeRules';
import type { AnalysisGame } from '@/engine/analysisGame';

// How close the position on the board is to the draw nobody chose.
//
// `QUIET_PLY_LIMIT` is the rule; this is the only place that turns it into
// something to look at. Kept apart from the meter that draws it because every
// decision here — when the rule is worth mentioning, what counts as close, what
// the numbers mean once they are moves rather than plies — is checkable
// arithmetic, and a component is not where checkable arithmetic should live.

/**
 * The rule as it is spoken about: a hundred moves, meaning a hundred from each
 * side.
 *
 * `QUIET_PLY_LIMIT` counts plies, which is the unit the rules run on and not
 * the one anybody says out loud — the end-of-game card, the rules page and the
 * result label all say a hundred moves. Derived from the limit rather than
 * written down again so the two cannot drift.
 */
export const QUIET_MOVE_LIMIT = QUIET_PLY_LIMIT / 2;

/**
 * How long the rule stays out of sight: twenty moves with nothing taken.
 *
 * Early enough that the count is on screen well before it decides anything, and
 * late enough that an ordinary opening — where the pieces have not met yet, and
 * a dozen quiet moves mean nothing at all — is not played under a meter
 * counting down to a draw that will never arrive.
 */
export const QUIET_MOVES_BEFORE_SHOWING = 20;

/** Past this the draw is a real prospect rather than a curiosity. */
const CLOSING_MOVES_PLAYED = QUIET_MOVE_LIMIT / 2;

/** Inside this the meter counts down instead of up. */
const IMMINENT_MOVES_LEFT = 10;

/**
 * How loudly the meter should say it.
 *
 * `counting` is a fact about the position, `closing` is a warning, and
 * `imminent` is a countdown: at ten moves left a player still has time to force
 * a capture, and nothing else on the board tells them they need to.
 */
export type QuietUrgency = 'counting' | 'closing' | 'imminent';

export interface QuietMoveClock {
  /** Moves played since the last capture, counting a move as one from each side. */
  movesPlayed: number;
  /** Moves left before the game is drawn. Never below one. */
  movesLeft: number;
  /** `QUIET_MOVE_LIMIT`, carried so the view never restates the rule itself. */
  limit: number;
  /** How far along the rule is, from 0 to 1. */
  progress: number;
  urgency: QuietUrgency;
}

/**
 * The rule's state in one position, or null when there is nothing to show.
 *
 * Null covers three answers that a screen treats identically — no position, a
 * game that is over, and a game where nothing has been shuffling — so a host
 * renders this unconditionally and gets a meter only when there is a reason
 * for one.
 *
 * A finished game is null because the rule can no longer take effect in it: the
 * result card says how the game actually ended, and a meter beside it claiming
 * a draw is thirty moves away would be describing a game that is not being
 * played any more.
 */
export const quietMoveClock = (
  game: Pick<AnalysisGame, 'quietPlies' | 'status'> | null | undefined,
): QuietMoveClock | null => {
  if (!game || game.status !== 'InProgress') return null;
  const plies = game.quietPlies;
  // `applyAnalysisMove` reads a missing count as zero rather than as a broken
  // game, for a position that reached it from somewhere that never kept one.
  // Same answer here: a count nobody kept is not a count to draw.
  if (!Number.isFinite(plies) || plies <= 0) return null;

  // Truncated, so the meter only claims a move once both sides have played it,
  // and the two figures still sum to the limit at every odd ply.
  const movesPlayed = Math.floor(plies / 2);
  const movesLeft = Math.ceil((QUIET_PLY_LIMIT - plies) / 2);
  if (movesPlayed < QUIET_MOVES_BEFORE_SHOWING) return null;

  return {
    movesPlayed,
    movesLeft: Math.max(1, movesLeft),
    limit: QUIET_MOVE_LIMIT,
    progress: Math.min(1, plies / QUIET_PLY_LIMIT),
    urgency:
      movesLeft <= IMMINENT_MOVES_LEFT
        ? 'imminent'
        : movesPlayed >= CLOSING_MOVES_PLAYED
          ? 'closing'
          : 'counting',
  };
};
