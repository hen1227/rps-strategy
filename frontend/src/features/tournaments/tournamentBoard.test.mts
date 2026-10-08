import assert from 'node:assert/strict';
import test from 'node:test';

import {
  matchesForFilter,
  overviewMatches,
  playedRecord,
} from './tournamentBoard.ts';
import type {
  Tournament,
  TournamentMatch,
  TournamentPlayer,
  TournamentStanding,
} from '@/types/protocol';

const player = (id: number): TournamentPlayer => ({
  playerId: id,
  userId: `user-${id}`,
  ign: `Player ${id}`,
  discord: '',
  agreedToUnfilteredChat: true,
  signupOrder: id,
  joinedAtUnixMs: 0,
});
const pairing = (
  id: number,
  result: TournamentMatch['result'] = 'pending',
): TournamentMatch => ({
  matchId: id,
  matchOrder: id,
  roundNumber: 1,
  player1: player(id),
  player2: player(20),
  result,
  updatedAtUnixMs: id,
});
const event: Tournament = {
  tournamentId: 'test',
  name: 'Test event',
  modeId: 'classic',
  modeName: 'Classic',
  status: 'in_progress',
  format: 'swiss',
  field: 'open',
  seeding: 'signup',
  maxPlayers: 0,
  gamesPerMatch: 1,
  rounds: 3,
  createdAtUnixMs: 0,
  players: [player(1), player(2)],
  standings: [],
  matches: [
    pairing(1, 'player1_win'),
    pairing(2),
    pairing(3),
    pairing(4, 'draw'),
    pairing(5),
  ],
  // Include a stale live marker on a decided match, as can happen between updates.
  matchStates: [
    { matchId: 1, live: true },
    { matchId: 3, live: true },
  ],
};

test('match filters partition decided, live, and upcoming matches without overlap', () => {
  const ids = (filter: Parameters<typeof matchesForFilter>[1]) =>
    matchesForFilter(event, filter).map((match) => match.matchId);
  assert.deepEqual(ids('all'), [1, 2, 3, 4, 5]);
  assert.deepEqual(ids('live'), [3]);
  assert.deepEqual(ids('upcoming'), [2, 5]);
  assert.deepEqual(ids('results'), [1, 4]);
  assert.deepEqual(matchesForFilter({ ...event, matches: [] }, 'live'), []);
});

test('overview prioritizes your entry and live boards and limits the preview', () => {
  assert.deepEqual(
    overviewMatches(event, 'user-5').map((match) => match.matchId),
    [5, 3, 2, 4],
  );
  assert.deepEqual(
    overviewMatches(event).map((match) => match.matchId),
    [3, 2, 5, 4],
  );
  assert.deepEqual(
    event.matches.map((match) => match.matchId),
    [1, 2, 3, 4, 5],
  );
});

test('bye points never inflate the played record or win rate', () => {
  const standing: TournamentStanding = {
    ...player(1),
    rank: 1,
    played: 4,
    wins: 3,
    byes: 1,
    draws: 1,
    losses: 1,
    points: 10,
  };
  assert.deepEqual(playedRecord(standing), {
    wins: 2,
    draws: 1,
    losses: 1,
    winRate: 50,
  });
  assert.equal(playedRecord({ ...standing, played: 0, wins: 1 }).winRate, null);
  assert.equal(playedRecord({ ...standing, wins: 0 }).wins, 0);
});
