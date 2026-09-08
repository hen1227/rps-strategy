// The engine-level rules a mode is allowed to change, and the ones it is not,
// for the copy of the rules that runs in the browser.
//
// Each is a question the server answers — the per-mode ones it declares as
// `no_repetition_draw` and `stalemate_loses` features on a ModeDefinition — and
// each has to be answered here too, because `applyAnalysisMove` adjudicates the
// same positions when it replays an archived game, walks a bot battle, or
// scores a line for the review.
//
// Keyed by mode id rather than by reading the features off a definition: every
// screen here has an id, and several of them synthesise a definition from one
// (see `gameReview.ts`), so a rule read off `features` would be right on the
// board and quietly wrong in the review. The ids are the same three constants
// `./goals` keys its answers on, and for the same reason.

import type { ModeID } from '@/types/game';

const MODE_INTRANSITIVE = 'V6';

/**
 * How many plies may pass with nothing captured before the game is a draw.
 *
 * `QuietPlyLimit` in `backend/internal/game/game.go`, and the same unit: one
 * per side per turn, so two hundred is a hundred moves each. Not keyed by mode and not
 * switchable, because it is the rule that makes every game finite — repetition
 * only catches a position that comes back, and an army with room to wander
 * need never repeat one.
 */
export const QUIET_PLY_LIMIT = 200;

/**
 * Whether this project plays the threefold-repetition draw at all. It does not.
 *
 * `game.RepetitionDrawEnabled` in `backend/internal/game/game.go`, and the two
 * have to hold the same value: the server adjudicates a live game and this
 * adjudicates the replay of one, so a disagreement shows up as a review that
 * ends on a different move from the game it is reviewing.
 *
 * One switch rather than the rule being deleted, because it has been on and off
 * before and the argument has two real sides: a repeated position is a claim to
 * half a point in a game decided by what is left on the board, and a defensive
 * resource in a race for one tile. What settles it for now is that neither
 * reading has to bound a game's length any more — `QUIET_PLY_LIMIT` does that,
 * in every mode, and unlike repetition it cannot be shuffled around by an army
 * with room to wander.
 */
const REPETITION_DRAW_ENABLED = false;

/**
 * Whether the third occurrence of a position is a draw in this mode.
 *
 * False everywhere while the switch above is off. The per-mode shape is kept
 * because that is the shape the answer has on the server — a mode may declare
 * `no_repetition_draw`, and Intransitive did, on the reasoning that a race for
 * one tile reads a repeat as a defensive resource. Turning the switch on puts
 * the rule back wherever a mode has not taken it away.
 */
export const repetitionDraws = (modeId: ModeID | undefined) =>
  REPETITION_DRAW_ENABLED && modeId !== MODE_INTRANSITIVE;

/**
 * Whether being unable to move loses rather than draws.
 *
 * On in Intransitive, where a game is a race: a side that blockades itself has
 * lost the race rather than survived it. Everywhere else "no legal move" is
 * nobody's fault and the shared result stands, which is what lets a mode with
 * no annihilation rule handle a wiped-out army.
 */
export const stalemateLoses = (modeId: ModeID | undefined) => modeId === MODE_INTRANSITIVE;
