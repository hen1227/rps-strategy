// The shape of the one store.
//
// Five slices compose into it, and each of them reaches the others through
// `get()` — the lobby's `selectTile` hands a bot game to the bot slice and a
// local game to the local one, and signing in reconnects the socket the lobby
// owns. Naming the whole store here
// is what lets every slice be typed against all of it without any of them
// having to import the others' code.

import type { BotSlice } from './botSession';
import type { LocalSlice } from './localSession';
import type { SessionSlice } from './accountSession';
import type { LobbySlice } from './gameStore';
import type { ReachSlice } from './reachTool';
import type {
  ClockState,
  GameSetup,
  GameState,
  PlayerProfile,
  SideColor,
  TimeControl,
} from '@/types/game';

export type GameStore = LobbySlice & BotSlice & LocalSlice & SessionSlice & ReachSlice;

/** The bot on the other side of a local practice game. */
export interface BotOpponent {
  blurb: string;
  color: SideColor;
  name: string;
  profileId: string;
  rating: number;
}

/** The two seats of a game being played out on one device. */
export interface LocalMatch {
  /**
   * The side the board is drawn from.
   *
   * Here rather than on the session because the screen reads `gameState` and
   * nothing else to decide which way up to draw a board, and a second place to
   * ask is a second answer to get wrong.
   */
  viewColor: SideColor;
}

/**
 * A game as every screen sees it.
 *
 * A server match arrives as a `GameState`. A bot game and a local game are
 * published in the same shape with no clock and their own marker set, which is
 * what lets one board, one player bar, and one set of sound effects serve all
 * three without knowing which they have.
 *
 * The two markers are mutually exclusive: `bot` means somebody is thinking on
 * the other side, `local` means both sides are this keyboard.
 */
export interface ActiveGame extends Omit<GameState, 'clock' | 'timeControl'> {
  clock: ClockState | null;
  timeControl: TimeControl | null;
  bot?: BotOpponent | null;
  local?: LocalMatch | null;
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

/**
 * A board that was taken away rather than finished, and why.
 *
 * A cancelled game is never filed: no result, no rating, no record. That makes
 * it different from every other way a board leaves the screen, and it is why
 * this is remembered separately from the game itself. Without it the two
 * screens that were showing the board are left with nothing to show and nothing
 * to say — and a spectator is left at an address pointing at a game that no
 * longer exists and has no record to fall back on.
 *
 * Keyed by game id, so it only ever explains its own board.
 */
export interface CancelledGame {
  gameId: string;
  message: string;
  atUnixMs: number;
}
