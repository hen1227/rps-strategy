import { apiClient } from './http';
import type { Account } from '@/types/protocol';

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
