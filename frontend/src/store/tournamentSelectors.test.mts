import assert from 'node:assert/strict';
import test from 'node:test';

import {
  championOf,
  isTiedStanding,
  joinNames,
  leadersOf,
  rankLabel,
  tableHasResults,
} from './tournamentSelectors.ts';
import type { Tournament, TournamentStanding } from '@/types/protocol';

const row = (
  playerId: number,
  ign: string,
  rank: number,
  points: number,
  played = 4,
): TournamentStanding => ({
  rank,
  playerId,
  ign,
  discord: '',
  played,
  wins: 0,
  losses: 0,
  draws: 0,
  points,
  signupOrder: playerId,
});

const event = (
  standings: TournamentStanding[],
  status: Tournament['status'] = 'completed',
): Tournament => ({
  tournamentId: 'arena',
  name: 'Weekend Bot Arena #5',
  modeId: 'classic',
  modeName: 'Intransitive',
  status,
  format: 'swiss',
  field: 'bots',
  seeding: 'rating',
  maxPlayers: 0,
  gamesPerMatch: 2,
  rounds: 4,
  createdAtUnixMs: 0,
  players: [],
  standings,
  matches: [],
});

// The table from the screenshot that asked for this, as the server now ranks it.
const arena = event([
  row(1, 'Mocca', 1, 10),
  row(2, 'Bu-0.2-lite', 1, 10),
  row(3, '1secondBot', 3, 7),
  row(4, 'VladHugeConvNet', 4, 6),
  row(5, 'Vlad_NNUE', 4, 6),
  row(6, 'TheraRPS', 6, 4),
]);

test('a shared place is marked, and a clear one is not', () => {
  const labels = arena.standings.map((standing) => rankLabel(arena, standing));
  assert.deepEqual(labels, ['T1', 'T1', '3', 'T4', 'T4', '6']);
  assert.equal(isTiedStanding(arena, arena.standings[0]), true);
  assert.equal(isTiedStanding(arena, arena.standings[2]), false);
});

test('everybody level at the top is a leader and a winner', () => {
  assert.deepEqual(
    leadersOf(arena).map((standing) => standing.ign),
    ['Mocca', 'Bu-0.2-lite'],
  );
  assert.equal(championOf(arena), 'Mocca & Bu-0.2-lite');
});

test('an outright winner is named alone', () => {
  const clear = event([row(1, 'Mocca', 1, 12), row(2, 'Bu-0.2-lite', 2, 10)]);
  assert.equal(championOf(clear), 'Mocca');
  assert.deepEqual(
    clear.standings.map((standing) => rankLabel(clear, standing)),
    ['1', '2'],
  );
});

test('an event still running has leaders but no winner', () => {
  const running = event(arena.standings, 'in_progress');
  assert.equal(championOf(running), null);
  assert.equal(leadersOf(running).length, 2);
});

test('before any result the table ranks nobody', () => {
  const doors = event(
    [row(1, 'Mocca', 1, 0, 0), row(2, 'Bu-0.2-lite', 1, 0, 0)],
    'registration',
  );
  assert.equal(tableHasResults(doors), false);
  assert.deepEqual(
    doors.standings.map((standing) => rankLabel(doors, standing)),
    ['–', '–'],
  );
  // A bye is a result: it is three points nobody else has.
  const byed = event(
    [{ ...row(1, 'Mocca', 1, 3, 0), byes: 1 }, row(2, 'Bu-0.2-lite', 2, 0, 0)],
    'in_progress',
  );
  assert.equal(tableHasResults(byed), true);
});

test('names read as a sentence, and a long tie is cut short', () => {
  assert.equal(joinNames([]), '');
  assert.equal(joinNames(['Ada']), 'Ada');
  assert.equal(joinNames(['Ada', 'Grace']), 'Ada & Grace');
  assert.equal(joinNames(['Ada', 'Grace', 'Kay']), 'Ada, Grace & Kay');
  assert.equal(
    joinNames(['Ada', 'Grace', 'Kay', 'Lin']),
    'Ada, Grace & 2 others',
  );
});
