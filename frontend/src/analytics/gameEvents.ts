import type { GameStatus, PlayerColor, TimeControl } from '@/types/game';

import type { AnalyticsEvents, GameKind } from './events';
import { timeControlLabel } from './events';

// Games starting and ending, read off the store rather than wired into it.
//
// All three kinds of game — on the server, against a practice bot, and two
// people at one screen — end up as the same `gameState` in the same store, so
// one observer covers them all and `gameStore.ts` needs no analytics of its
// own. What it watches for:
//
//   - **A start** is a board with a new game ID on it that this player is
//     playing, not watching, with no move made yet. "No move yet" is what
//     tells a new game from one restored after a reload; a reload in the few
//     seconds before the first move is counted twice, which is a price worth
//     paying for not touching the socket handlers.
//   - **An end** is the same game going from unfinished to finished, for a
//     player rather than a spectator. A finished game opened from history was
//     never unfinished here, so it is not an end.
//
// Each game ID is reported once per kind of event, whatever the store does
// afterwards: a pass-and-play game can be undone and finished again.

/** The part of a board the observer reads, whichever kind of game is on it. */
export interface ObservedBoard {
  gameId: string;
  status: GameStatus;
  moveNumber: number;
  winner: PlayerColor;
  endReason?: string;
  mode: { id: string };
  /** Absent on a practice or pass-and-play board with no clock. */
  timeControl?: TimeControl | null;
  redPlayer?: { userId?: string } | null;
  bluePlayer?: { userId?: string } | null;
}

/** The part of the store the observer reads. */
export interface ObservedGame {
  gameState: ObservedBoard | null;
  playerColor: PlayerColor | null;
  isSpectating: boolean;
  engineBots: { userId?: string }[];
}

export type GameEvent =
  | { name: 'game_start'; params: AnalyticsEvents['game_start'] }
  | { name: 'game_end'; params: AnalyticsEvents['game_end'] };

const kindOf = (gameId: string): GameKind =>
  gameId.startsWith('bot-') ? 'practice' : gameId.startsWith('local-') ? 'local' : 'online';

const opponentOf = (state: ObservedGame, game: ObservedBoard, kind: GameKind): 'human' | 'bot' => {
  if (kind === 'practice') return 'bot';
  if (kind === 'local') return 'human';
  const opponent = state.playerColor === 'Red' ? game.bluePlayer : game.redPlayer;
  const id = opponent?.userId ?? '';
  // Engine accounts are minted as bot-…, and the lobby's roster names them too.
  return id.startsWith('bot-') || state.engineBots.some((bot) => bot.userId === id)
    ? 'bot'
    : 'human';
};

const resultOf = (
  state: ObservedGame,
  game: ObservedBoard,
  kind: GameKind,
): AnalyticsEvents['game_end']['result'] => {
  if (game.winner === 'Neutral') return 'draw';
  if (kind === 'local') return 'decided';
  return game.winner === state.playerColor ? 'win' : 'loss';
};

export const createGameObserver = () => {
  const started = new Set<string>();
  const ended = new Set<string>();

  return (next: ObservedGame, prev: ObservedGame): GameEvent[] => {
    const game = next.gameState;
    if (!game || next.isSpectating) return [];
    const events: GameEvent[] = [];
    const kind = kindOf(game.gameId);
    const previous = prev.gameState?.gameId === game.gameId ? prev.gameState : null;

    if (
      !previous &&
      game.status === 'InProgress' &&
      game.moveNumber === 0 &&
      !started.has(game.gameId)
    ) {
      started.add(game.gameId);
      events.push({
        name: 'game_start',
        params: {
          mode: game.mode.id,
          kind,
          opponent: opponentOf(next, game, kind),
          time_control: timeControlLabel(game.timeControl ?? undefined),
        },
      });
    }

    if (
      previous &&
      previous.status !== 'Finished' &&
      game.status === 'Finished' &&
      !ended.has(game.gameId)
    ) {
      ended.add(game.gameId);
      events.push({
        name: 'game_end',
        params: {
          mode: game.mode.id,
          kind,
          opponent: opponentOf(next, game, kind),
          result: resultOf(next, game, kind),
          end_reason: game.endReason ?? 'none',
          moves: game.moveNumber,
        },
      });
    }
    return events;
  };
};
