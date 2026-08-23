import { API_URL } from './serverConfig';

const parseResponse = async (response, what) => {
  const contentType = response.headers.get('content-type') ?? '';
  const payload = contentType.includes('application/json')
    ? await response.json().catch(() => null)
    : await response.text().catch(() => '');
  if (!response.ok) {
    const message = payload?.error || (typeof payload === 'string' && payload.trim());
    throw new Error(message || `${what} failed (${response.status}).`);
  }
  return payload;
};

const unreachable = (error, what) => {
  if (error instanceof TypeError) throw new Error(`Could not reach the server to ${what}.`);
  throw error;
};

/** The stored record of one game, as text. */
export const getGamePGN = async (gameId) => {
  try {
    const response = await fetch(
      `${API_URL}/api/games/${encodeURIComponent(gameId)}/pgn`,
      { headers: { Accept: 'text/plain' } },
    );
    return parseResponse(response, 'Loading the game record');
  } catch (error) {
    return unreachable(error, 'load the game record');
  }
};

/**
 * Report a finished review.
 *
 * The numbers are computed in the browser, so the server records who claimed
 * them and what they were measured with rather than treating them as its own
 * verdict — see `backend/docs/review.md`. Nothing about a rating depends on
 * this call, which is what makes storing a client's own measurement
 * acceptable at all.
 */
export const putGameAccuracy = async (gameId, profileKey, report) => {
  try {
    const response = await fetch(
      `${API_URL}/api/games/${encodeURIComponent(gameId)}/accuracy`,
      {
        method: 'PUT',
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${profileKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(report),
      },
    );
    return parseResponse(response, 'Saving the review');
  } catch (error) {
    return unreachable(error, 'save the review');
  }
};

/** Both players' stored accuracies for a game, when anyone has reviewed it. */
export const getGameAccuracy = async (gameId) => {
  try {
    const response = await fetch(
      `${API_URL}/api/games/${encodeURIComponent(gameId)}/accuracy`,
      { headers: { Accept: 'application/json' } },
    );
    return parseResponse(response, 'Loading stored reviews');
  } catch (error) {
    return unreachable(error, 'load stored reviews');
  }
};
