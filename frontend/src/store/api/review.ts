import { apiClient } from './http';
import type { GradeKey } from '@/engine/gameReview';
import type { SideColor } from '@/types/game';

const request = apiClient('game archive');

/** The stored record of one game, as text. */
export const getGamePGN = (gameId: string) =>
  request<string>(`/api/games/${encodeURIComponent(gameId)}/pgn`, {
    accept: 'text/plain',
    what: 'Loading the game record',
  });

/** One player's stored review of a game. */
export interface StoredAccuracy {
  accuracy: number;
  moveCount: number;
  averageLossPercent: number;
  averageLossCentipawns: number;
  grades: Partial<Record<GradeKey, number>>;
  preset?: string;
  depth?: number;
  measuredAtUnixMs?: number;
}

export type StoredAccuracies = Partial<Record<SideColor, StoredAccuracy>>;

/**
 * Report a finished review.
 *
 * The numbers are computed in the browser, so the server records who claimed
 * them and what they were measured with rather than treating them as its own
 * verdict — see `backend/docs/review.md`. Nothing about a rating depends on
 * this call, which is what makes storing a client's own measurement
 * acceptable at all.
 */
export const putGameAccuracy = (gameId: string, profileKey: string, report: unknown) =>
  request<StoredAccuracies>(`/api/games/${encodeURIComponent(gameId)}/accuracy`, {
    method: 'PUT',
    token: profileKey,
    body: report,
    what: 'Saving the review',
  });

/** Both players' stored accuracies for a game, when anyone has reviewed it. */
export const getGameAccuracy = (gameId: string) =>
  request<StoredAccuracies>(`/api/games/${encodeURIComponent(gameId)}/accuracy`, {
    what: 'Loading stored reviews',
  });
