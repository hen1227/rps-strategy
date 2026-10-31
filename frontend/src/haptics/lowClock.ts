import { LOW_TIME_MS } from '@/store/clockSelectors';
import { FIRST_MOVE_WINDOW_MS } from '@/store/queueSelectors';
import type { ActiveGame } from '@/store/types';
import type { PlayerColor } from '@/types/game';

// When a countdown running low is worth a buzz.
//
// Two countdowns can run out on a player: their clock, and — before anybody
// has moved — the window to make the first move, after which the game is
// called off. Each is watched the same way, against its own line: the clock
// against the twenty seconds at which its face turns red, the first move
// against the ten at which its notice goes urgent. Same lines as the screen,
// so the buzz and the red arrive together.
//
// Once per crossing, not once per turn. With an increment a clock in time
// trouble bobs across the line every move, and a phone that buzzed each time
// would be a phone people turn the buzz off on. So after a buzz the watch only
// re-arms once the clock has climbed back to twice the line — which a
// three-minute extension does and a few seconds of increment never will.
//
// And only a crossing that was seen. A clock that was already under the line
// when it was first looked at — a game with less than twenty seconds on it, a
// rejoin in time trouble — never crossed in front of anybody, and buzzing for
// it at the first look would be buzzing for nothing that happened.

/** One look at a countdown that belongs to this player. */
export interface CountdownReading {
  /** The game it belongs to. A new game starts the watch over. */
  gameId: string;
  /** What is left on it at the moment it was read. */
  remainingMs: number;
  /** Whether it is running down for this player right now. */
  running: boolean;
}

export interface LowWatch {
  gameId: string | null;
  /** Seen above the line since the last buzz, so going under it is news. */
  armed: boolean;
  /** Has buzzed this game, so re-arming waits for twice the line. */
  buzzed: boolean;
}

export const IDLE_WATCH: LowWatch = { gameId: null, armed: false, buzzed: false };

export interface WatchStep {
  watch: LowWatch;
  /** Whether this look is the crossing. */
  buzz: boolean;
  /** When the line will be crossed if nothing changes: when to look again. */
  checkInMs: number | null;
}

export const watchCountdown = (
  watch: LowWatch,
  reading: CountdownReading | null,
  lineMs: number,
): WatchStep => {
  if (!reading) return { watch, buzz: false, checkInMs: null };
  const sameGame = reading.gameId === watch.gameId;
  let armed = sameGame && watch.armed;
  let buzzed = sameGame && watch.buzzed;
  const { remainingMs, running } = reading;

  if (buzzed ? remainingMs >= lineMs * 2 : remainingMs > lineMs) {
    armed = true;
    buzzed = false;
  }
  if (armed && running && remainingMs > 0 && remainingMs <= lineMs) {
    return { watch: { gameId: reading.gameId, armed: false, buzzed: true }, buzz: true, checkInMs: null };
  }
  return {
    watch: { gameId: reading.gameId, armed, buzzed },
    buzz: false,
    checkInMs: armed && running && remainingMs > lineMs ? remainingMs - lineMs : null,
  };
};

const playing = (color: PlayerColor | null): color is 'Red' | 'Blue' =>
  color === 'Red' || color === 'Blue';

/**
 * This player's clock, read at `nowMs`, or null when there is none of theirs
 * to watch.
 *
 * The same arithmetic as the clock face: the snapshot, less what has elapsed
 * since it was taken if it is the one running.
 */
export const clockReading = (
  game: ActiveGame | null | undefined,
  playerColor: PlayerColor | null,
  nowMs: number,
): CountdownReading | null => {
  if (!game?.clock || game.local || game.status !== 'InProgress' || !playing(playerColor)) {
    return null;
  }
  const { clock } = game;
  const snapshot = playerColor === 'Red' ? clock.redRemainingMs : clock.blueRemainingMs;
  const running = clock.activeColor === playerColor;
  const elapsed = running ? Math.max(0, nowMs - clock.updatedAtUnixMs) : 0;
  return { gameId: game.gameId, remainingMs: Math.max(0, snapshot - elapsed), running };
};

/**
 * This player's first-move window, read at `nowMs`, while a board nobody has
 * played on waits for its first move. Running only when that move is theirs:
 * the other side's countdown is the other side's to worry about.
 */
export const firstMoveReading = (
  game: ActiveGame | null | undefined,
  playerColor: PlayerColor | null,
  deadlineUnixMs: number | null,
  nowMs: number,
): CountdownReading | null => {
  if (!game || !deadlineUnixMs || game.bot || game.local || !playing(playerColor)) return null;
  if (game.status !== 'InProgress' || game.clock?.activeColor !== 'Neutral') return null;
  // Clamped to the window, as the notice is: the two clocks can disagree.
  const remainingMs = Math.min(Math.max(0, deadlineUnixMs - nowMs), FIRST_MOVE_WINDOW_MS);
  return { gameId: game.gameId, remainingMs, running: game.currentTurn === playerColor };
};
