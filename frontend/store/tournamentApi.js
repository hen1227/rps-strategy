import { API_URL } from './serverConfig';

const request = async (path, { method = 'GET', body, adminToken } = {}) => {
  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (adminToken) headers.Authorization = `Bearer ${adminToken}`;

  let response;
  try {
    response = await fetch(`${API_URL}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new Error('Could not reach the tournament server.');
  }

  const contentType = response.headers.get('content-type') ?? '';
  const payload = contentType.includes('application/json')
    ? await response.json().catch(() => null)
    : await response.text().catch(() => '');
  if (!response.ok) {
    const message = payload?.error || (typeof payload === 'string' && payload.trim());
    throw new Error(message || `Tournament request failed (${response.status}).`);
  }
  return payload;
};

export const listTournaments = () => request('/api/tournaments');

export const verifyAdminToken = (adminToken) =>
  request('/api/admin/session', { adminToken });

export const createTournament = (adminToken, name, modeId) =>
  request('/api/admin/tournaments', {
    method: 'POST',
    adminToken,
    body: { name, modeId },
  });

export const signupForTournament = (
  tournamentId,
  { userId, ign, discord, agreedToUnfilteredChat, reservationToken },
) =>
  request(`/api/tournaments/${encodeURIComponent(tournamentId)}/signups`, {
    method: 'POST',
    body: { userId, ign, discord, agreedToUnfilteredChat, reservationToken },
  });

export const startTournament = (adminToken, tournamentId) =>
  request(`/api/admin/tournaments/${encodeURIComponent(tournamentId)}/start`, {
    method: 'POST',
    adminToken,
  });

export const setMatchResult = (adminToken, tournamentId, matchId, result) =>
  request(
    `/api/admin/tournaments/${encodeURIComponent(tournamentId)}/matches/${matchId}`,
    {
      method: 'PATCH',
      adminToken,
      body: { result },
    },
  );
