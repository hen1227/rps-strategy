// The public ladder.
//
// One route serves both boards, because they are the same question asked of two
// populations. Which one you get is a parameter rather than a path, so a screen
// that switches between them changes an argument and not a client.

import { apiClient } from './http';
import type { ModeID } from '@/types/game';
import type { LeaderboardEntry } from '@/types/protocol';

const request = apiClient('leaderboard');

export type LeaderboardKind = 'human' | 'bot';

export interface LeaderboardQuery {
  /** A per-mode ladder. Omitted means the account-wide rating. */
  modeId?: ModeID | null;
  kind?: LeaderboardKind;
  /** Games a player must have finished to be listed. The server defaults to 1. */
  minGames?: number;
  limit?: number;
  offset?: number;
}

export const leaderboard = ({
  modeId,
  kind,
  minGames,
  limit,
  offset,
}: LeaderboardQuery = {}) => {
  const query = new URLSearchParams();
  if (modeId) query.set('mode', modeId);
  if (kind) query.set('kind', kind);
  if (minGames !== undefined) query.set('minGames', String(minGames));
  if (limit !== undefined) query.set('limit', String(limit));
  if (offset !== undefined) query.set('offset', String(offset));
  const suffix = query.size > 0 ? `?${query}` : '';
  return request<LeaderboardEntry[]>(`/api/leaderboard${suffix}`, {
    what: 'Loading the leaderboard',
  });
};
