// How a finished game reads in one line.
//
// There were two of these and about to be a third: the bot battle screen mapped
// end reasons to words for its own header, the game screen has its own longer
// second-person version, and the bot match history needs the same phrase again
// with names in it instead of colours. A third copy would be a third chance for
// `repetition` to read as "threefold repetition" on one screen and "repetition"
// on the next.
//
// The game screen's version stays where it is on purpose: it is written to the
// player who just finished — "Your clock expired" — which is a different piece of
// writing rather than the same one formatted differently.

import type { GameEndReason, PlayerColor } from '@/types/game';

/**
 * The words for *how* a game ended, or undefined when the reason adds nothing.
 *
 * `game_rule` is deliberately absent: it is the server's fallback for "the mode
 * decided", so "wins by game rule" would be noise where the reader wants either
 * a real reason or none.
 */
export const endReasonPhrase = (
  endReason: GameEndReason | string | null | undefined,
): string | undefined =>
  ({
    abandonment: 'abandonment',
    annihilation: 'annihilation',
    draw_agreement: 'agreement',
    infiltration: 'infiltration',
    move_limit: 'move limit',
    repetition: 'threefold repetition',
    resignation: 'resignation',
    stalemate: 'stalemate',
    territory: 'territory',
    timeout: 'time',
  })[endReason ?? ''];

/** "Red wins by annihilation" — for a board whose seats have no names. */
export const colourResultLabel = (
  winner: PlayerColor,
  endReason: GameEndReason | string | null,
) => {
  const result = winner === 'Neutral' ? 'Draw' : `${winner} wins`;
  const reason = endReasonPhrase(endReason);
  return reason ? `${result} by ${reason}` : result;
};

/**
 * "Alpha beat Beta by territory" — for a row about two named players.
 *
 * Past tense, and the winner first, because this describes a game that is over
 * to somebody who was not watching it. A draw names both in the order they sat.
 */
export const namedResultLabel = (options: {
  redName: string;
  blueName: string;
  /** Null on a draw, which is the case the winner's name cannot cover. */
  winnerName: string | null;
  endReason: GameEndReason | string | null;
}) => {
  const { blueName, endReason, redName, winnerName } = options;
  const reason = endReasonPhrase(endReason);
  const suffix = reason ? ` by ${reason}` : '';
  if (!winnerName) return `${redName} and ${blueName} drew${suffix}`;
  const loser = winnerName === redName ? blueName : redName;
  return `${winnerName} beat ${loser}${suffix}`;
};
