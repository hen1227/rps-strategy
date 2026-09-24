import { apiClient } from './http';
import type { Account, GameRecord, Title, TitleID } from '@/types/protocol';

const request = apiClient('account server');

export const getAccount = (userId: string) =>
  request<Account>(`/api/accounts/${encodeURIComponent(userId)}`, {
    what: 'Loading the account',
  });

// Editing a profile takes the session token rather than the browser's local
// key: only a registered account has a name and a Discord handle of its own.
export const updateAccount = (
  userId: string,
  sessionToken: string,
  username: string,
  discord: string,
  reservationToken = '',
) =>
  request<Account>(`/api/accounts/${encodeURIComponent(userId)}`, {
    method: 'PATCH',
    token: sessionToken,
    body: { username, discord, reservationToken },
    what: 'Saving the profile',
  });

/**
 * The games an account has finished, newest first.
 *
 * Public, and deliberately: these are the same games the archive already
 * serves by id, and a player's own history is the list a shared review link
 * came out of. No token, therefore, and it works for any account id — which is
 * what a profile page other than your own would need.
 */
export const getGameHistory = (userId: string, limit = 10, offset = 0) =>
  request<GameRecord[]>(
    `/api/accounts/${encodeURIComponent(userId)}/games?limit=${limit}&offset=${offset}`,
    { what: 'Loading your games' },
  );

/**
 * Choose which owned title goes in front of the name. `''` wears none.
 *
 * Its own route rather than a field on the profile PATCH, because the two are
 * not edited together: a title is picked from a list of things already earned,
 * while the profile form is free text that can fail validation. Sharing one
 * would mean a rejected username also lost the title chosen beside it.
 */
export const setAccountTitle = (userId: string, sessionToken: string, title: TitleID | '') =>
  request<Account>(`/api/accounts/${encodeURIComponent(userId)}/title`, {
    method: 'PUT',
    token: sessionToken,
    body: { title },
    what: 'Saving the title',
  });

/**
 * Store the look this player chose, so it follows them to their other devices.
 *
 * Its own route for the same reason the title has one: this saves on every tap,
 * and coupling it to the profile form would mean a rejected username also cost
 * the player the theme they picked beside it.
 */
export const setAccountAppearance = (
  userId: string,
  sessionToken: string,
  appearance: string,
) =>
  request<Account>(`/api/accounts/${encodeURIComponent(userId)}/appearance`, {
    method: 'PUT',
    token: sessionToken,
    body: { appearance },
    what: 'Saving your appearance',
  });

/** Every title there is, in display order. Public: an unearned one is worth chasing. */
export const getTitleCatalogue = () =>
  request<Title[]>('/api/titles', { what: 'Loading titles' });
