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
import type {
  ClockState,
  GameSetup,
  GameState,
  PlayerProfile,
  SideColor,
  TimeControl,
} from '@/types/game';

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
  /**
   * The game being searched for. A plain search carries the mode's standard
   * setup; a search with a clock or a rule changed carries that instead, which
   * is why this is the whole setup rather than just a mode.
   */
  setup: GameSetup | null;
  searchRange: number;
  /**
   * The local-clock instant this wait began, so the label ticks by itself
   * rather than only advancing when the server pushes.
   *
   * Anchored on receipt from the server's `queuedForMs`, which is a duration
   * and therefore immune to the two clocks disagreeing. Storing the instant
   * instead of the duration is also what makes "your wait is preserved" true
   * after a no-show: nothing touches the anchor.
   */
  queuedSinceUnixMs: number | null;
}

/**
 * A game that has been arranged but has not started, because somebody has to
 * answer for it first.
 *
 * The two roles are genuinely different screens. `summoned` means the seat is
 * yours to take and the clock is running on you; `present` means you are
 * already in and the countdown belongs to the other person.
 */
export interface QueueClaim {
  pendingId: string;
  role: 'summoned' | 'present';
  /** Absolute local-clock instant, anchored on receipt. */
  deadlineUnixMs: number;
  opponent: PlayerProfile;
  opponentElo: number | null;
  modeId: string;
  modeName: string;
  setup: GameSetup;
  /** True from tapping the claim button until the game arrives. */
  claiming: boolean;
}

/** Why the last hold came to nothing, shown briefly and then forgotten. */
export interface QueueMiss {
  message: string;
  atUnixMs: number;
}
