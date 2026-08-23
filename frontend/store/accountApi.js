import { API_URL } from './serverConfig';

const parseResponse = async (response) => {
  const contentType = response.headers.get('content-type') ?? '';
  const payload = contentType.includes('application/json')
    ? await response.json().catch(() => null)
    : await response.text().catch(() => '');
  if (!response.ok) {
    const message = payload?.error || (typeof payload === 'string' && payload.trim());
    throw new Error(message || `Account request failed (${response.status}).`);
  }
  return payload;
};

export const getAccount = async (userId) => {
  try {
    const response = await fetch(`${API_URL}/api/accounts/${encodeURIComponent(userId)}`, {
      headers: { Accept: 'application/json' },
    });
    return parseResponse(response);
  } catch (error) {
    if (error instanceof TypeError) throw new Error('Could not reach the account server.');
    throw error;
  }
};

// Editing a profile takes the session token rather than the browser's local
// key: only a registered account has a name and a Discord handle of its own.
export const updateAccount = async (
  userId,
  sessionToken,
  username,
  discord,
  reservationToken = '',
) => {
  try {
    const response = await fetch(`${API_URL}/api/accounts/${encodeURIComponent(userId)}`, {
      method: 'PATCH',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${sessionToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ username, discord, reservationToken }),
    });
    return parseResponse(response);
  } catch (error) {
    if (error instanceof TypeError) throw new Error('Could not reach the account server.');
    throw error;
  }
};
