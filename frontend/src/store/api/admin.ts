import { apiClient } from './http';
import type { ModeID, PlayerProfile } from '@/types/game';
import type { Restriction, RestrictionKind } from '@/types/protocol';

// The host's routes that are about the running server rather than about a row
// in the database.
//
// Kept apart from `bots.ts`, where the account and game administration lives,
// and from `serverAdmin.ts`, which is the drain and the notice. The split that
// matters is not by feature but by *what a failure means*: everything here
// reads or interrupts live state, so a stale answer is normal and a screen
// holding one should refetch rather than trust it.

const request = apiClient('server');

/* ------------------------------------------------------------- analytics -- */

export interface AccountTotals {
  total: number;
  registered: number;
  /** The population with a profile page. */
  discordLinked: number;
  bots: number;
  disabled: number;
  admins: number;
  newLast7Days: number;
  newLast30Days: number;
  /** Accounts that finished a game in the last week. */
  activeLast7Days: number;
}

export interface GameTotals {
  total: number;
  ranked: number;
  last24Hours: number;
  last7Days: number;
  last30Days: number;
  draws: number;
  redWins: number;
  blueWins: number;
  /** Medians rather than means: both distributions have a long tail. */
  medianMoves: number;
  medianSeconds: number;
}

export interface ModeActivity {
  modeId: ModeID;
  modeName: string;
  games: number;
  last7Days: number;
  ranked: number;
  players: number;
}

export interface DailyActivity {
  /** Midnight UTC at the start of the day. */
  dayUnixMs: number;
  games: number;
  ranked: number;
  players: number;
}

export interface TournamentTotals {
  drafts: number;
  registration: number;
  inProgress: number;
  completed: number;
  cancelled: number;
  entrants: number;
}

export interface ModerationTotals {
  muted: number;
  rankedBanned: number;
  tournamentBanned: number;
}

/** Everything the overview draws, as the server computes it. */
export interface StoredAnalytics {
  generatedAtUnixMs: number;
  accounts: AccountTotals;
  games: GameTotals;
  byMode: ModeActivity[];
  /** Thirty days, oldest first, with no gaps. */
  daily: DailyActivity[];
  tournaments: TournamentTotals;
  moderation: ModerationTotals;
}

/**
 * The figures that cannot come from the database, because they are about the
 * process: who is connected, and what they are doing.
 */
export interface LiveAnalytics {
  onlineCount: number;
  liveGames: number;
  queued: Partial<Record<ModeID, number>>;
  botsConnected: number;
  botsPractising: number;
  openChallenges: number;
}

export interface Analytics {
  stored: StoredAnalytics;
  live: LiveAnalytics;
}

export const readAnalytics = (adminToken: string) =>
  request<Analytics>('/api/admin/analytics', {
    token: adminToken,
    what: 'Reading the numbers',
  });

/* ------------------------------------------------------------ moderation -- */

/** A sanction as the admin screen sees it, which includes lapsed ones. */
export interface AdminRestriction extends Restriction {
  /** The administrator who placed it, when there was an account to record. */
  issuedBy?: string;
  issuedAtUnixMs: number;
}

/** Every sanction on record against an account, lapsed ones included. */
export const listRestrictions = (adminToken: string, userId: string) =>
  request<AdminRestriction[]>(
    `/api/admin/accounts/${encodeURIComponent(userId)}/restrictions`,
    { token: adminToken, what: 'Reading the sanctions' },
  );

export interface RestrictOptions {
  kind: RestrictionKind;
  reason?: string;
  /**
   * How long it stands. Zero or omitted means until it is lifted, which is
   * available and is not the default — see the note on the server side about
   * why a sanction with no end tends to become permanent by accident.
   */
  durationSeconds?: number;
}

/**
 * Place or extend a sanction.
 *
 * Placing the same kind twice replaces it, so this is also how "another hour"
 * works: there is still exactly one to lift afterwards.
 */
export const restrictAccount = (
  adminToken: string,
  userId: string,
  options: RestrictOptions,
) =>
  request<AdminRestriction>(
    `/api/admin/accounts/${encodeURIComponent(userId)}/restrictions`,
    {
      method: 'POST',
      token: adminToken,
      body: {
        kind: options.kind,
        reason: options.reason ?? '',
        durationSeconds: options.durationSeconds ?? 0,
      },
      what: 'Placing the sanction',
    },
  );

export const liftRestriction = (
  adminToken: string,
  userId: string,
  kind: RestrictionKind,
) =>
  request<{ lifted: boolean }>(
    `/api/admin/accounts/${encodeURIComponent(userId)}/restrictions/${kind}`,
    { method: 'DELETE', token: adminToken, what: 'Lifting the sanction' },
  );

/* ----------------------------------------------------------- live  games -- */

/** A board in progress, with the account ids the public rail does not carry. */
export interface AdminLiveGame {
  gameId: string;
  modeId: ModeID;
  modeName: string;
  redPlayer: PlayerProfile;
  bluePlayer: PlayerProfile;
  redUserId: string;
  blueUserId: string;
  redIsBot: boolean;
  blueIsBot: boolean;
  ranked: boolean;
  moveNumber: number;
  spectatorCount: number;
  /** Zero for a game that has been opened but not begun. */
  startedAtUnixMs: number;
  /**
   * Opened but not begun, which is also the one state in which the players can
   * still abort it themselves. Worth showing, so a host does not stop a game
   * that is about to expire on its own.
   */
  awaitingFirstMove: boolean;
  tournamentId?: string;
  /** A series game cannot be stopped from here; abort the series instead. */
  seriesId?: string;
}

export const listLiveGames = (adminToken: string) =>
  request<AdminLiveGame[]>('/api/admin/live-games', {
    token: adminToken,
    what: 'Reading the live games',
  });

/**
 * What a stopped game is stopped *as*.
 *
 * `void` files nothing: the board disappears, no result is stored, no rating
 * moves. The other three declare a result and the game is filed and rated
 * exactly as if it had ended that way on the board.
 */
export type StopOutcome = 'void' | 'draw' | 'red' | 'blue';

export const stopLiveGame = (
  adminToken: string,
  gameId: string,
  outcome: StopOutcome,
  reason?: string,
) =>
  request<{ gameId: string; outcome: string; recorded: boolean }>(
    `/api/admin/live-games/${encodeURIComponent(gameId)}/stop`,
    {
      method: 'POST',
      token: adminToken,
      body: { outcome, reason: reason ?? '' },
      what: 'Stopping the game',
    },
  );

/* ------------------------------------------------------------ bot control -- */

/** A connected engine, with the socket detail the public roster omits. */
export interface AdminBot {
  botId: string;
  userId: string;
  name: string;
  ownerUserId?: string;
  engineName?: string;
  modes?: ModeID[];
  /** Sockets held, and how many are in a game. The gap is idle capacity. */
  connections: number;
  activeGames: number;
  /** What the client asked for, which can exceed `connections`. */
  declaredSlots: number;
  clientVersion?: string;
  /** Feed it to `botIconUrl` with the bot id. Absent for most engines. */
  iconSha256?: string;
  draining: boolean;
  benched: boolean;
  reservedFor?: string;
  allowPublicPlay: boolean;
  enterTournaments: boolean;
  elo: number;
  restricted?: Restriction[];
}

export const listAdminBots = (adminToken: string) =>
  request<AdminBot[]>('/api/admin/bots', {
    token: adminToken,
    what: 'Reading the engines',
  });

/**
 * Close an engine's sockets, now.
 *
 * The last resort of four, and the others are usually right:
 * `shutdownBot` drains it and lets it finish what it is playing, the bench
 * stands every engine down for a window, and retiring removes the registry
 * row. This one hangs up mid-game. Its owner's process is untouched and will
 * very likely reconnect, which is the point — the usual next step is for them
 * to fix something and restart it.
 */
export const disconnectBot = (adminToken: string, botId: string, reason?: string) =>
  request<{ botId: string; connectionsClosed: number }>(
    `/api/admin/bots/${encodeURIComponent(botId)}/disconnect`,
    {
      method: 'POST',
      token: adminToken,
      body: { reason: reason ?? '' },
      what: 'Disconnecting the bot',
    },
  );
