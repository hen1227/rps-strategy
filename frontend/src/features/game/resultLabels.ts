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
import type { GameRecord } from '@/types/protocol';

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
    corner: 'reaching the corner',
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

/** The name of whoever won a stored game, or null on a draw. */
export const recordWinnerName = (record: GameRecord) => {
  if (record.winnerUserId === record.redPlayer.userId) return record.redPlayer.username;
  if (record.winnerUserId === record.bluePlayer.userId) return record.bluePlayer.username;
  return null;
};

/**
 * `namedResultLabel` for a game the server has filed.
 *
 * The bot feed and a player's own history are lists of the same thing, and
 * both were unpacking a record into the four fields above by hand. One place
 * that knows how a `GameRecord` reads, so a row cannot say "beat" on one page
 * and "drew" on the next for the same game.
 */
export const recordResultLabel = (record: GameRecord) =>
  namedResultLabel({
    blueName: record.bluePlayer.username,
    endReason: record.endReason,
    redName: record.redPlayer.username,
    winnerName: recordWinnerName(record),
  });

/**
 * How a stored game went for one of the two people in it.
 *
 * `unknown` covers the reader who was not playing — a spectator, or anybody
 * who opened a shared link — because "not a win" and "a loss" are different
 * things and a row must not claim the second when it means the first.
 */
export const resultForPlayer = (
  record: GameRecord,
  userId: string,
): 'win' | 'loss' | 'draw' | 'unknown' => {
  const seated =
    userId === record.redPlayer.userId || userId === record.bluePlayer.userId;
  if (!seated) return 'unknown';
  if (!record.winnerUserId) return 'draw';
  return record.winnerUserId === userId ? 'win' : 'loss';
};
