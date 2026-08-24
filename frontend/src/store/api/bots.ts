// The bot registry, the auth routes, and the account administration behind them.
//
// The credential here is a *session* token, which the server distinguishes from
// a profile key by its `rps_s_` prefix rather than by which route it arrived
// on — so `token` means different things to different calls below, and each one
// says which it wants.

import { apiClient } from './http';
import { identityCredential, identityScope, type RequestIdentity } from './identity';
import { API_URL } from '../serverConfig';
import type { ModeID, TimeControl } from '@/types/game';
import type {
  Account,
  AccountKind,
  BotPresence,
  GameRecord,
  Tournament,
} from '@/types/protocol';

const request = apiClient('bot registry');

/* --------------------------------------------------------------- accounts -- */

/** A signed-in session: the token to keep and the account it belongs to. */
export interface SessionReply {
  token: string;
  account: Account;
}

export const registerAccount = (
  profileKey: string,
  userId: string,
  username: string,
  password: string,
  reservationToken = '',
) =>
  request<SessionReply>('/api/auth/register', {
    method: 'POST',
    token: profileKey,
    body: { userId, username, password, reservationToken },
    what: 'Registering',
  });

export const loginAccount = (username: string, password: string) =>
  request<SessionReply>('/api/auth/login', {
    method: 'POST',
    body: { username, password },
    what: 'Signing in',
  });

export const logoutAccount = (token: string) =>
  request<unknown>('/api/auth/logout', { method: 'POST', token, what: 'Signing out' });

export const currentAccount = (token: string) =>
  request<Account>('/api/auth/me', { token, what: 'Loading the account' });

/** The username rules, so the client and the server cannot disagree on them. */
export interface IdentityPolicy {
  minLength: number;
  maxLength: number;
  pattern: string;
  reservedNames: string[];
}

export const identityPolicy = () =>
  request<IdentityPolicy>('/api/identity/policy', { what: 'Loading the name rules' });

/* ------------------------------------------------------------------- bots -- */

/**
 * A registered bot slot.
 *
 * `userId` and `name` are empty until the client first connects and claims the
 * slot, which the account page shows as "unclaimed".
 */
export interface Bot {
  botId: string;
  ownerUserId: string;
  userId?: string;
  name?: string;
  description: string;
  allowPublicPlay: boolean;
  enterTournaments: boolean;
  engineName?: string;
  engineAuthor?: string;
  engineModes?: ModeID[];
  /** The digest of the icon its client sent, or absent when it sent none. */
  iconSha256?: string;
  claimed: boolean;
  disabled: boolean;
  retired: boolean;
  createdAtUnixMs: number;
  lastSeenAtUnixMs?: number;
}

/** A bot in the public directory, with whether it is connected right now. */
export interface DirectoryBot extends Bot {
  online: boolean;
}

/** What the owner's own list carries: their bots, and how many more they may make. */
export interface OwnedBots {
  bots: Bot[];
  limit: number;
  remaining: number;
}

/** A minted or rotated token. The token is readable exactly once. */
export interface MintedBot {
  bot: Bot;
  token: string;
}

export interface BotSettings {
  name?: string;
  description?: string;
  allowPublicPlay?: boolean;
  enterTournaments?: boolean;
}

export const listBots = () =>
  request<DirectoryBot[]>('/api/bots', { what: 'Loading bots' });

export const listMyBots = (token: string) =>
  request<OwnedBots>('/api/bots/mine', { token, what: 'Loading your bots' });

/** Mints a bot slot. The token in the reply is shown once and never again. */
export const createBot = (token: string) =>
  request<MintedBot>('/api/bots', { method: 'POST', token, what: 'Creating a bot' });

export const updateBot = (token: string, botId: string, settings: BotSettings) =>
  request<Bot>(`/api/bots/${botId}`, {
    method: 'PATCH',
    token,
    body: settings,
    what: 'Saving the bot',
  });

export const rotateBotToken = (token: string, botId: string) =>
  request<MintedBot>(`/api/bots/${botId}/token`, {
    method: 'POST',
    token,
    what: 'Rotating the token',
  });

export const retireBot = (token: string, botId: string) =>
  request<unknown>(`/api/bots/${botId}`, { method: 'DELETE', token, what: 'Retiring the bot' });

/* ----------------------------------------------------------------- series -- */

export type BotSeriesStatus = 'pending' | 'running' | 'completed' | 'aborted';

export type BotSeriesResult = 'pending' | 'first_win' | 'second_win' | 'draw';

export interface BotSeriesGame {
  gameNumber: number;
  pairNumber: number;
  /** True when the seats were swapped, so the first bot played Blue. */
  swapped: boolean;
  gameId?: string;
  openingLine?: string;
  /** Always from the first bot's point of view, whichever colour it held. */
  result: BotSeriesResult | string;
  /** How the game ended: `abandonment`, `resignation`, `timeout`, and so on. */
  endReason?: string;
}

export interface BotSeries {
  seriesId: string;
  modeId: ModeID;
  firstBotId: string;
  secondBotId: string;
  firstBotName?: string;
  secondBotName?: string;
  /** The engines' pictures. Feed to `botIconUrl` with the matching bot id. */
  firstBotIconSha256?: string;
  secondBotIconSha256?: string;
  /**
   * The accounts the two engines play under. A bot has two ids — the registry
   * id this run is keyed on, and the account id every game record and ladder
   * row carries — so a page showing the ladder's own runs needs both.
   */
  firstBotUserId?: string;
  secondBotUserId?: string;
  /** Who asked for the run. Absent on one started with the host token. */
  requestedByUserId?: string;
  requestedByName?: string;
  status: BotSeriesStatus | string;
  pairs: number;
  openingPlies: number;
  /**
   * A string, because it is a full 64-bit value: as a JSON number it would
   * arrive rounded, and a seed you cannot paste back is not a seed.
   */
  seed: string;
  initialTimeMs: number;
  incrementMs: number;
  firstWins: number;
  secondWins: number;
  draws: number;
  games?: BotSeriesGame[];
  createdAtUnixMs: number;
  completedAtUnixMs?: number;
}

export interface StartBotSeriesOptions {
  modeId: ModeID;
  firstBotId: string;
  secondBotId: string;
  pairs?: number;
  openingPlies?: number;
  /** Digits, or omitted to let the server pick one. See `BotSeries.seed`. */
  seed?: string;
  /** Omitted means the server's default. */
  timeControl?: TimeControl;
}

export const listBotSeries = (limit?: number) =>
  request<BotSeries[]>(`/api/bot-series${limit ? `?limit=${limit}` : ''}`, {
    what: 'Loading bot series',
  });

/** One run, with its games. */
export const botSeries = (seriesId: string) =>
  request<BotSeries>(`/api/bot-series/${encodeURIComponent(seriesId)}`, {
    what: 'Loading the series',
  });

/**
 * The run one game belonged to, or null when it was not part of one.
 *
 * Asked by the review and spectate screens, which are handed a game id and have
 * no other way to know it is the fourth of six. A query rather than something
 * carried on the link, so a pasted URL gets the strip too.
 */
export const botSeriesForGame = async (gameId: string) => {
  const found = await request<BotSeries[]>(
    `/api/bot-series?game=${encodeURIComponent(gameId)}`,
    { what: 'Loading the series' },
  );
  return found?.[0] ?? null;
};

/**
 * Pit two bots against each other.
 *
 * Anybody may do this, which is why it takes an identity rather than the host
 * token: the server holds a public request to a short run at a fast clock, needs
 * both bots to be open to public play, and lets one account hold one run at a
 * time. The row it creates says who asked, so the scoreboard can say so too.
 */
export const startBotSeries = (identity: RequestIdentity, options: StartBotSeriesOptions) =>
  request<BotSeries>(`/api/bot-series${identityScope(identity)}`, {
    method: 'POST',
    token: identityCredential(identity),
    body: options,
    what: 'Starting the series',
  });

/** Stop a run you started. The server refuses anybody else's. */
export const abortBotSeries = (identity: RequestIdentity, seriesId: string) =>
  request<{ aborted: boolean }>(
    `/api/bot-series/${seriesId}/abort${identityScope(identity)}`,
    {
      method: 'POST',
      token: identityCredential(identity),
      what: 'Stopping the series',
    },
  );

/** The host's version: any length, any clock, and it can stop anybody's run. */
export const startAdminBotSeries = (adminToken: string, options: StartBotSeriesOptions) =>
  request<BotSeries>('/api/admin/bot-series', {
    method: 'POST',
    token: adminToken,
    body: options,
    what: 'Starting the series',
  });

export const abortAdminBotSeries = (adminToken: string, seriesId: string) =>
  request<{ aborted: boolean }>(`/api/admin/bot-series/${seriesId}/abort`, {
    method: 'POST',
    token: adminToken,
    what: 'Stopping the series',
  });

/* ---------------------------------------------------------------- matches -- */

/**
 * One finished game between two bots.
 *
 * An ordinary game record — a bot plays through the same machinery a person
 * does — plus the run it belonged to, when it belonged to one. Games a bot
 * played against a person are deliberately not here: they are unranked, so they
 * cannot answer which engine is stronger, which is the only question this list
 * is asked.
 */
export interface BotMatch extends GameRecord {
  /**
   * The occasion this game belonged to, when it belonged to one. A run and an
   * event are both several games that are really one thing that happened, and
   * the history is read as a list of those rather than of games.
   */
  seriesId?: string;
  tournamentId?: string;
}

export interface BotMatchQuery {
  /** Bot *account* ids. Repeated, so a board of top bots can ask for its own. */
  botUserIds?: string[];
  /** One mode's games, to match a per-mode ladder. Omitted means every mode. */
  modeId?: ModeID | null;
  limit?: number;
  offset?: number;
}

export const botMatches = ({ botUserIds, modeId, limit, offset }: BotMatchQuery = {}) => {
  const query = new URLSearchParams();
  for (const userId of botUserIds ?? []) query.append('botId', userId);
  if (modeId) query.set('mode', modeId);
  if (limit !== undefined) query.set('limit', String(limit));
  if (offset !== undefined) query.set('offset', String(offset));
  const suffix = query.size > 0 ? `?${query}` : '';
  return request<BotMatch[]>(`/api/bot-matches${suffix}`, { what: 'Loading bot games' });
};

export const enrollBotsInTournament = (adminToken: string, tournamentId: string) =>
  request<Tournament>(`/api/admin/tournaments/${tournamentId}/enroll-bots`, {
    method: 'POST',
    token: adminToken,
    what: 'Enrolling bots',
  });

/* ------------------------------------------------------------------ guide -- */

/** Everything the bot guide page needs: versions, digests, links, and the docs. */
export interface BotGuide {
  version: string;
  minimumVersion: string;
  sha256: string;
  downloadUrl: string;
  exampleUrl: string;
  exampleSha256: string;
  /** The handout, as Markdown. The same text as `docs/bots.md`. */
  guide: string;
  /** The engine protocol, as Markdown. The same text as `docs/rpsi.md`. */
  protocol: string;
}

export const botGuide = () => request<BotGuide>('/api/bot/guide', { what: 'Loading the guide' });

/** Where the client script and the example engine are served from. */
export const botClientScriptUrl = `${API_URL}/api/bot/rpsbot.py`;
export const exampleEngineUrl = `${API_URL}/api/bot/example_engine.py`;

/**
 * The URL of a bot's icon, or undefined when it has none.
 *
 * `id` is either of the two ids a bot has — the registry id an owner's page
 * knows it by, or the account id it plays under, which is what a ladder row or
 * a game record carries. The endpoint answers to both, so no list has to fetch
 * an id it would otherwise never need.
 *
 * The digest goes in the query string rather than being ignored: it is what
 * makes the answer cacheable for ever, since an icon that changes changes this
 * URL. Without one the server still answers, but only briefly cacheable.
 */
export const botIconUrl = (id: string | undefined, digest: string | undefined) =>
  id && digest ? `${API_URL}/api/bots/${id}/icon.png?v=${digest}` : undefined;

/* --------------------------------------------------- account administration -- */
// These take the host token, which `adminOnly` also accepts from a signed-in
// administrator's session.

/**
 * One row of the admin account list.
 *
 * A projection rather than a whole `Account`: the list wants counts and flags,
 * and loading every mode rating for a page of fifty accounts is wasted work.
 */
export interface AccountSummary {
  userId: string;
  kind: AccountKind | string;
  username: string;
  discord: string;
  registered: boolean;
  isAdmin: boolean;
  disabled: boolean;
  elo: number;
  gamesPlayed: number;
  /** How many bot slots this account owns. */
  botCount: number;
  createdAtUnixMs: number;
}

export interface AccountFlags {
  disabled?: boolean;
  isAdmin?: boolean;
  username?: string;
  discord?: string;
}

export const listAccounts = (adminToken: string, query = '') =>
  request<AccountSummary[]>(`/api/admin/accounts?query=${encodeURIComponent(query)}`, {
    token: adminToken,
    what: 'Loading accounts',
  });

export const updateAccountFlags = (adminToken: string, userId: string, flags: AccountFlags) =>
  request<AccountSummary>(`/api/admin/accounts/${userId}`, {
    method: 'PATCH',
    token: adminToken,
    body: flags,
    what: 'Updating the account',
  });

export const anonymizeAccount = (adminToken: string, userId: string) =>
  request<unknown>(`/api/admin/accounts/${userId}`, {
    method: 'DELETE',
    token: adminToken,
    what: 'Anonymizing the account',
  });

/** An account with everything an admin might want to remove from it. */
export interface AccountDetail {
  account: Account;
  bots: Bot[];
  games: GameRecord[];
}

export const accountDetail = (adminToken: string, userId: string, limit = 25) =>
  request<AccountDetail>(`/api/admin/accounts/${userId}?limit=${limit}`, {
    token: adminToken,
    what: 'Loading the account',
  });

/** What a purge removed, so the screen can say it rather than guess. */
export interface AccountPurge {
  userId: string;
  username: string;
  gamesDeleted: number;
  botsDeleted: number;
  tournamentEntriesDeleted: number;
}

/**
 * Delete an account outright, with its games, bots, and tournament entries.
 *
 * The hard neighbour of `anonymizeAccount`, which keeps the games and only
 * removes the person. Separate paths on the server too, so the destructive one
 * cannot be reached by a typo in the other's URL.
 */
export const purgeAccount = (adminToken: string, userId: string) =>
  request<AccountPurge>(`/api/admin/accounts/${userId}/purge`, {
    method: 'DELETE',
    token: adminToken,
    what: 'Deleting the account',
  });

/** What a game deletion removed. The two tables can disagree, so both are reported. */
export interface GameDeletion {
  gameId: string;
  historyDeleted: boolean;
  archiveDeleted: boolean;
  reviewsDeleted: number;
  ratingsReverted: boolean;
}

export const listAdminGames = (adminToken: string, query = '', limit = 50) =>
  request<GameRecord[]>(
    `/api/admin/games?query=${encodeURIComponent(query)}&limit=${limit}`,
    { token: adminToken, what: 'Loading games' },
  );

/**
 * Delete one game from the history and the archive.
 *
 * `revertRatings` defaults to true on the server as well: the usual reason to
 * delete a game is that its result should not stand, so both players get the
 * Elo and the win count back unless the caller says otherwise.
 */
export const deleteGame = (adminToken: string, gameId: string, revertRatings = true) =>
  request<GameDeletion>(
    `/api/admin/games/${encodeURIComponent(gameId)}?revertRatings=${revertRatings}`,
    { method: 'DELETE', token: adminToken, what: 'Deleting the game' },
  );

/** What deleting a bot removed. */
export interface BotDeletion {
  botId: string;
  name: string;
  gamesDeleted: number;
  seriesDeleted: number;
  accountDeleted: boolean;
}

/**
 * Delete a bot entirely: its games, its series, and the account it played under.
 *
 * `deleteBot` in the owner section retires instead — the bot leaves play and
 * its games stay, because they are also its opponents' games. This is the one
 * for a bot whose record is itself the problem.
 */
export const purgeBot = (adminToken: string, botId: string) =>
  request<BotDeletion>(`/api/admin/bots/${botId}`, {
    method: 'DELETE',
    token: adminToken,
    what: 'Deleting the bot',
  });
