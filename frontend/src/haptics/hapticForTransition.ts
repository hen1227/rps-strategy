import { getGameSoundForTransition } from '@/hooks/gameSoundForTransition';
import type { ActiveGame } from '@/store/types';
import type { PlayerColor, SideColor } from '@/types/game';

import { VERDICT_DELAY_MS, type BuzzMoment, type HapticEvent } from './recipes';

// What a change of game state should feel like, for the person holding the
// phone.
//
// Built on the sound's own reading of the change, so a capture that clicks is
// a capture that taps and the two can never disagree about what happened. What
// differs is who it is for. A sound narrates the game to anybody listening; a
// tap answers the person playing it. So:
//
// - Your own move taps under your finger the moment you make it (see the
//   board), not when the server echoes it a round trip later, and so nothing
//   here taps for it. Every move at a shared board is a touch on this phone.
// - A spectator feels nothing. Watching is not playing, and a phone that taps
//   through somebody else's game is a phone buzzing in a pocket for no reason.
// - A game you are in starting is the one moment for the motor rather than a
//   tap: it is when the phone is most likely lying on a table. A bot or a
//   shared board starts because you just pressed the button for it, which
//   already tapped.

export type GameFeel =
  | { kind: 'haptic'; event: HapticEvent; delayMs?: number }
  | { kind: 'buzz'; moment: BuzzMoment };

const CAPTURE_SOUNDS = new Set(['paperTakesRock', 'rockTakesScissors', 'scissorsTakesPaper']);

const playing = (color: PlayerColor | null): color is SideColor =>
  color === 'Red' || color === 'Blue';

export const gameHapticForTransition = (
  previous: ActiveGame | null | undefined,
  next: ActiveGame | null | undefined,
  playerColor: PlayerColor | null,
): GameFeel | null => {
  const sound = getGameSoundForTransition(previous, next, playerColor);
  if (!sound || !next) return null;

  if (sound === 'start') {
    if (next.bot || next.local || !playing(playerColor)) return null;
    return { kind: 'buzz', moment: 'gameStart' };
  }
  // A game rejoined, or one somebody else is part-way through.
  if (sound === 'notify') return null;

  if (sound === 'end') {
    if (next.local) return { kind: 'haptic', event: 'ended', delayMs: VERDICT_DELAY_MS };
    if (!playing(playerColor)) return null;
    const event =
      next.winner === 'Neutral' ? 'draw' : next.winner === playerColor ? 'win' : 'loss';
    return { kind: 'haptic', event, delayMs: VERDICT_DELAY_MS };
  }

  if (next.local || !playing(playerColor)) return null;
  // Whose move it was is whose turn it had been.
  if (previous?.currentTurn === playerColor) return null;
  return { kind: 'haptic', event: CAPTURE_SOUNDS.has(sound) ? 'captured' : 'theirMove' };
};

/**
 * Whether the other side has just asked you something: a draw, or more time.
 *
 * Read off the pair of snapshots, as the notices on the board are: an offer is
 * a field that was not set and now names your opponent. Your own offer, and the
 * same offer still standing a snapshot later, are not news.
 */
export const offerArrived = (
  previous: ActiveGame | null | undefined,
  next: ActiveGame | null | undefined,
  playerColor: PlayerColor | null,
): boolean => {
  if (!previous || !next || previous.gameId !== next.gameId) return false;
  if (!playing(playerColor) || next.status !== 'InProgress') return false;
  const opponent = playerColor === 'Red' ? 'Blue' : 'Red';
  const fresh = (before: PlayerColor | undefined, after: PlayerColor | undefined) =>
    after === opponent && before !== opponent;
  return (
    fresh(previous.drawOfferedBy, next.drawOfferedBy) ||
    fresh(previous.timeOfferedBy, next.timeOfferedBy)
  );
};
