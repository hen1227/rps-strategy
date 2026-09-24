import { apiClient } from './http';
import type { ModeID } from '@/types/game';
import type {
  GameRecord,
  ModeRating,
  RatingState,
  TitleAward,
  TitleID,
  TournamentFormat,
  TournamentStatus,
} from '@/types/protocol';

// Public player pages.
//
// Unauthenticated, like the leaderboard they hang off. Nothing on a profile is
// new information — every field is already served by the account route, the
// history route, the titles route or the ladder — which is worth knowing when
// adding to it: a profile is a join, not a disclosure.
//
// **Who has one.** Accounts Discord has vouched for, plus bots. Not a privacy
// setting but a consequence: most accounts here are anonymous per-browser
// identities called "Guest", and a directory of those is not a feature. A
// linked Discord is also what makes a name unique enough to be an address.

const request = apiClient('player directory');

/** One event on somebody's page. */
export interface ProfileTournament {
  tournamentId: string;
  name: string;
  modeName: string;
  status: TournamentStatus;
  format: TournamentFormat;
  /** Where they finished, absent for an event still running. */
  placement?: number;
  /** What a placement is out of: third of four is not third of forty. */
  fieldSize: number;
  enteredAtUnixMs: number;
}

/** One engine on its owner's page. */
export interface ProfileBot {
  botId: string;
  name: string;
  description?: string;
  iconSha256?: string;
  elo: number;
  /** Whether `elo` is a measurement. Absent from a server older than the field. */
  ratingState?: RatingState;
  username: string;
  userId: string;
}

/**
 * One spell an engine spent at the top of one mode.
 *
 * `endedAtUnixMs` is absent while the reign is the one in progress, which
 * `current` also says; read the age of a current reign against now.
 */
export interface BotReign {
  userId: string;
  modeId: ModeID | string;
  startedAtUnixMs: number;
  endedAtUnixMs?: number;
  current: boolean;
}

/** One build an engine has been seen running. */
export interface BotEngineVersion {
  version: string;
  firstSeenAtUnixMs: number;
  lastSeenAtUnixMs: number;
}

export interface PlayerProfilePage {
  userId: string;
  username: string;
  title?: TitleID;
  discord: string;
  titles?: TitleAward[];
  /** `human` or `bot`. Engines get pages too. */
  kind: string;
  /**
   * The mode they are strongest in, matching the row the ladder lists them by:
   * the best *measured* one, and only then the best number.
   */
  elo: number;
  /** Whether `elo` is a measurement. Absent from a server older than the field. */
  ratingState?: RatingState;
  wins: number;
  losses: number;
  draws: number;
  gamesPlayed: number;
  modeRatings: Partial<Record<ModeID, ModeRating>>;
  joinedAtUnixMs: number;
  /**
   * When they last finished a game, absent for somebody who never has. Taken
   * from their history rather than from a login, because the games are the
   * public record and "last played" is the honest version of "last seen" on a
   * site whose whole purpose is playing.
   */
  lastSeenAtUnixMs?: number;
  recentGames: GameRecord[];
  tournaments?: ProfileTournament[];
  bots?: ProfileBot[];
  /**
   * Every spell this engine has spent top of a mode, newest first. Bot pages
   * only, and absent for an engine that has never led — which is most of them.
   *
   * Reigns are only recorded from the day the ledger shipped, so an empty list
   * means "not since then" rather than "never".
   */
  reigns?: BotReign[];
  /**
   * The builds this engine has been seen running, newest first. Bot pages
   * only, and absent for an engine that declares no build.
   */
  engineVersions?: BotEngineVersion[];
}

/** One row of the directory. */
export interface PlayerSummary {
  userId: string;
  username: string;
  discord: string;
  title?: TitleID;
  kind: string;
  elo: number;
  gamesPlayed: number;
  titleCount: number;
}

/**
 * One player's page, by username or by user id.
 *
 * Either, because the two arrive from different places: a link somebody typed
 * carries a name, and a badge built from a game record carries an id. The
 * server resolves both, so a caller never has to work out which it is holding.
 */
export const playerProfile = (handle: string, games = 20) =>
  request<PlayerProfilePage>(
    `/api/players/${encodeURIComponent(handle)}?games=${games}`,
    { what: 'Loading the player' },
  );

/** The directory, optionally filtered by a fragment of a name. */
export const listPlayers = (query = '', limit = 50, offset = 0) => {
  const params = new URLSearchParams();
  if (query.trim()) params.set('query', query.trim());
  params.set('limit', String(limit));
  params.set('offset', String(offset));
  return request<PlayerSummary[]>(`/api/players?${params.toString()}`, {
    what: 'Loading players',
  });
};

/**
 * A further page of somebody's games.
 *
 * Addressed by handle rather than by user id so that paging keeps working when
 * the visitor arrived by name, which is the usual way.
 */
export const playerGames = (handle: string, limit = 20, offset = 0) =>
  request<GameRecord[]>(
    `/api/players/${encodeURIComponent(handle)}/games?limit=${limit}&offset=${offset}`,
    { what: 'Loading more games' },
  );
