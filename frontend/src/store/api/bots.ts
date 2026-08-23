// The bot registry, the auth routes, and the account administration behind them.
//
// The credential here is a *session* token, which the server distinguishes from
// a profile key by its `rps_s_` prefix rather than by which route it arrived
// on — so `token` means different things to different calls below, and each one
// says which it wants.

import { apiClient } from './http';
import { API_URL } from '../serverConfig';
import type { ModeID, TimeControl } from '@/types/game';
import type { Account, AccountKind, BotPresence, Tournament } from '@/types/protocol';

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
  status: BotSeriesStatus | string;
  pairs: number;
  openingPlies: number;
  seed: number;
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
  seed?: number;
  /** Omitted means the server's default. */
  timeControl?: TimeControl;
}

export const listBotSeries = () =>
  request<BotSeries[]>('/api/bot-series', { what: 'Loading bot series' });

export const startBotSeries = (adminToken: string, options: StartBotSeriesOptions) =>
  request<BotSeries>('/api/admin/bot-series', {
    method: 'POST',
    token: adminToken,
    body: options,
    what: 'Starting the series',
  });

export const abortBotSeries = (adminToken: string, seriesId: string) =>
  request<BotSeries>(`/api/admin/bot-series/${seriesId}/abort`, {
    method: 'POST',
    token: adminToken,
    what: 'Aborting the series',
  });

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
