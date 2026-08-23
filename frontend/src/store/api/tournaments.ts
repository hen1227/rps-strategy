import { apiClient } from './http';
import type { ModeID } from '@/types/game';
import type { Tournament, TournamentMatchResult } from '@/types/protocol';

const request = apiClient('tournament server');

export const listTournaments = () =>
  request<Tournament[]>('/api/tournaments', { what: 'Loading tournaments' });

export const verifyAdminToken = (adminToken: string) =>
  request<unknown>('/api/admin/session', { token: adminToken, what: 'Checking the host token' });

export const createTournament = (adminToken: string, name: string, modeId: ModeID) =>
  request<Tournament>('/api/admin/tournaments', {
    method: 'POST',
    token: adminToken,
    body: { name, modeId },
    what: 'Creating the tournament',
  });

export interface TournamentSignup {
  userId: string;
  ign: string;
  discord: string;
  agreedToUnfilteredChat: boolean;
  reservationToken?: string;
}

export const signupForTournament = (tournamentId: string, signup: TournamentSignup) =>
  request<Tournament>(`/api/tournaments/${encodeURIComponent(tournamentId)}/signups`, {
    method: 'POST',
    body: signup,
    what: 'Signing up',
  });

export const startTournament = (adminToken: string, tournamentId: string) =>
  request<Tournament>(`/api/admin/tournaments/${encodeURIComponent(tournamentId)}/start`, {
    method: 'POST',
    token: adminToken,
    what: 'Starting the tournament',
  });

export const setMatchResult = (
  adminToken: string,
  tournamentId: string,
  matchId: number,
  result: TournamentMatchResult,
) =>
  request<Tournament>(
    `/api/admin/tournaments/${encodeURIComponent(tournamentId)}/matches/${matchId}`,
    {
      method: 'PATCH',
      token: adminToken,
      body: { result },
      what: 'Recording the result',
    },
  );
