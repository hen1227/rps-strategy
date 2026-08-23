import { API_URL } from './serverConfig';

// The bot registry and the account routes behind it.
//
// Same shape as `tournamentApi.js` and `openingBookApi.js`: one private
// `request`, a bearer credential chosen per call, and thin exported functions.
// The credential differs though — these take a *session* token, which the
// server distinguishes from a profile key by its `rps_s_` prefix rather than by
// which route it arrived on.

const request = async (path, { method = 'GET', body, token } = {}) => {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;

  const response = await fetch(`${API_URL}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = null;
  }
  if (!response.ok) {
    const error = new Error(payload?.error ?? 'The bot registry is unavailable.');
    // Carried so a caller can tell "your session is gone" from "the network
    // hiccuped", which are the same message but very different reactions.
    error.status = response.status;
    throw error;
  }
  return payload;
};

// Accounts

export const registerAccount = (profileKey, userId, username, password, reservationToken = '') =>
  request('/api/auth/register', {
    method: 'POST',
    token: profileKey,
    body: { userId, username, password, reservationToken },
  });

export const loginAccount = (username, password) =>
  request('/api/auth/login', { method: 'POST', body: { username, password } });

export const logoutAccount = (token) =>
  request('/api/auth/logout', { method: 'POST', token });

export const currentAccount = (token) => request('/api/auth/me', { token });

export const identityPolicy = () => request('/api/identity/policy');

// Bots

export const listBots = () => request('/api/bots');

export const listMyBots = (token) => request('/api/bots/mine', { token });

/** Mints a bot slot. The token in the reply is shown once and never again. */
export const createBot = (token) => request('/api/bots', { method: 'POST', token });

export const updateBot = (token, botId, settings) =>
  request(`/api/bots/${botId}`, { method: 'PATCH', token, body: settings });

export const rotateBotToken = (token, botId) =>
  request(`/api/bots/${botId}/token`, { method: 'POST', token });

export const retireBot = (token, botId) =>
  request(`/api/bots/${botId}`, { method: 'DELETE', token });

// Series

export const listBotSeries = () => request('/api/bot-series');

export const startBotSeries = (adminToken, options) =>
  request('/api/admin/bot-series', { method: 'POST', token: adminToken, body: options });

export const abortBotSeries = (adminToken, seriesId) =>
  request(`/api/admin/bot-series/${seriesId}/abort`, { method: 'POST', token: adminToken });

export const enrollBotsInTournament = (adminToken, tournamentId) =>
  request(`/api/admin/tournaments/${tournamentId}/enroll-bots`, {
    method: 'POST',
    token: adminToken,
  });

/** Everything the bot guide page needs: versions, digests, links, and the docs. */
export const botGuide = () => request('/api/bot/guide');

/** Where the client script and the example engine are served from. */
export const botClientScriptUrl = `${API_URL}/api/bot/rpsbot.py`;
export const exampleEngineUrl = `${API_URL}/api/bot/example_engine.py`;

// Account administration. These take the host token, which `adminOnly` also
// accepts from a signed-in administrator's session.

export const listAccounts = (adminToken, query = '') =>
  request(`/api/admin/accounts?query=${encodeURIComponent(query)}`, { token: adminToken });

export const updateAccountFlags = (adminToken, userId, flags) =>
  request(`/api/admin/accounts/${userId}`, { method: 'PATCH', token: adminToken, body: flags });

export const anonymizeAccount = (adminToken, userId) =>
  request(`/api/admin/accounts/${userId}`, { method: 'DELETE', token: adminToken });
