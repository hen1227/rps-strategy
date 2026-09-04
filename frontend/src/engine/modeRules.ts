// The two engine-level rules a mode is allowed to change, for the copy of the
// rules that runs in the browser.
//
// Both are questions the server answers per mode — it declares them as
// `no_repetition_draw` and `stalemate_loses` features on a ModeDefinition — and
// both have to be answered here too, because `applyAnalysisMove` adjudicates
// the same positions when it replays an archived game, walks a bot battle, or
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
 * Whether the third occurrence of a position is a draw.
 *
 * Off in Intransitive: with one tile to reach, repeating a position is a
 * defensive resource rather than a claim to half a point. Nothing else bounds
 * the length of such a game — only the clock does.
 */
export const repetitionDraws = (modeId: ModeID | undefined) => modeId !== MODE_INTRANSITIVE;

/**
 * Whether being unable to move loses rather than draws.
 *
 * On in Intransitive, where a game is a race: a side that blockades itself has
 * lost the race rather than survived it. Everywhere else "no legal move" is
 * nobody's fault and the shared result stands, which is what lets a mode with
 * no annihilation rule handle a wiped-out army.
 */
export const stalemateLoses = (modeId: ModeID | undefined) => modeId === MODE_INTRANSITIVE;
