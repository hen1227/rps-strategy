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

export interface BotSeriesGame {
  gameNumber: number;
  pairNumber: number;
  swapped: boolean;
  gameId?: string;
  openingLine?: string;
  result: string;
}

export interface BotSeries {
  seriesId: string;
  modeId: ModeID;
  firstBotId: string;
  secondBotId: string;
  firstBotName?: string;
  secondBotName?: string;
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
  seriesId?: string;
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
