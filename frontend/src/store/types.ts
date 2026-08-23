// The shape of the one store.
//
// Three slices compose into it, and each of them reaches the others through
// `get()` — the lobby's `selectTile` hands a bot game to the bot slice, and
// signing in reconnects the socket the lobby owns. Naming the whole store here
// is what lets every slice be typed against all of it without any of them
// having to import the others' code.

import type { BotSlice } from './botSession';
import type { SessionSlice } from './accountSession';
import type { LobbySlice } from './gameStore';
import type { ClockState, GameState, SideColor, TimeControl } from '@/types/game';

export type GameStore = LobbySlice & BotSlice & SessionSlice;

/** The bot on the other side of a local practice game. */
export interface BotOpponent {
  blurb: string;
  color: SideColor;
  name: string;
  profileId: string;
  rating: number;
}

/**
 * A game as every screen sees it.
 *
 * A server match arrives as a `GameState`. A bot game is published in the same
 * shape with `bot` set and no clock, which is what lets one board, one player
 * bar, and one set of sound effects serve both without knowing which they have.
 */
export interface ActiveGame extends Omit<GameState, 'clock' | 'timeControl'> {
  clock: ClockState | null;
  timeControl: TimeControl | null;
  bot?: BotOpponent | null;
}

/** How far the socket has got. */
export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'rejoining';

export interface QueueState {
  isSearching: boolean;
  modeId: string | null;
  searchRange: number;
  queuedForMs: number;
}
