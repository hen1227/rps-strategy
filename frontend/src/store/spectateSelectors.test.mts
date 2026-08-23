import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  liveBoardsOf,
  nextGameOfSeries,
  seriesScoreLabel,
  seriesScoreOf,
  tournamentForGame,
} from './spectateSelectors';
import type {
  LiveGameSeries,
  LiveGameSummary,
  Tournament,
  TournamentMatch,
  TournamentPlayer,
} from '@/types/protocol';

const player = (playerId: number, ign: string): TournamentPlayer => ({
  playerId,
  userId: `user-${playerId}`,
  ign,
  discord: '',
  agreedToUnfilteredChat: true,
  signupOrder: playerId,
  joinedAtUnixMs: 0,
});

const match = (matchId: number, first: string, second: string): TournamentMatch => ({
  matchId,
  roundNumber: 1,
  matchOrder: matchId,
  player1: player(matchId * 2 - 1, first),
  player2: player(matchId * 2, second),
  result: 'pending',
  updatedAtUnixMs: 0,
});

const tournament = (): Tournament => ({
  tournamentId: 'summer',
  name: 'Summer Open',
  modeId: 'V5',
  modeName: 'Total War',
  status: 'in_progress',
  players: [],
  standings: [],
  matches: [match(1, 'Ada', 'Bo'), match(2, 'Cy', 'Di'), match(3, 'Eve', 'Fay')],
  createdAtUnixMs: 0,
  matchStates: [
    { matchId: 1, gameId: 'game-1', live: true, readyUserIds: [] },
    // Readied up but not started: there is no board to watch yet.
    { matchId: 2, live: false, readyUserIds: ['user-3'] },
    { matchId: 3, gameId: 'game-3', live: true, readyUserIds: [] },
  ],
});

const series = (overrides: Partial<LiveGameSeries> = {}): LiveGameSeries => ({
  seriesId: 'run-1',
  gameNumber: 3,
  totalGames: 8,
  firstWins: 2,
  secondWins: 0,
  draws: 0,
  firstIsRed: true,
  ...overrides,
});

const liveGame = (gameId: string, overrides: Partial<LiveGameSummary> = {}): LiveGameSummary => ({
  gameId,
  modeId: 'V5',
  modeName: 'Total War',
  redPlayer: { userId: 'red', username: 'Alpha' },
  bluePlayer: { userId: 'blue', username: 'Beta' },
  redElo: 1500,
  blueElo: 1500,
  spectatorCount: 0,
  startedAtUnixMs: 0,
  ...overrides,
});

describe('tournament boards', () => {
  it('lists only the matches with a game running', () => {
    const boards = liveBoardsOf(tournament());
    assert.deepEqual(
      boards.map((board) => board.gameId),
      ['game-1', 'game-3'],
    );
  });

  it('names each board from the schedule, first player as Red', () => {
    const [first] = liveBoardsOf(tournament());
    assert.equal(first?.redName, 'Ada');
    assert.equal(first?.blueName, 'Bo');
  });

  it('finds the tournament a live game belongs to', () => {
    assert.equal(tournamentForGame([tournament()], 'game-3')?.tournamentId, 'summer');
    assert.equal(tournamentForGame([tournament()], 'somebody-elses-game'), null);
  });
});

describe('bot series', () => {
  it('offers the only other live board of the run', () => {
    const games = [
      liveGame('game-a', { series: series() }),
      liveGame('game-b', { series: series({ seriesId: 'another-run' }) }),
    ];
    assert.equal(nextGameOfSeries(games, 'run-1', 'game-a'), null);
    assert.equal(nextGameOfSeries(games, 'run-1', 'game-z')?.gameId, 'game-a');
  });

  it('reads the tally against the seats of the game in front of it', () => {
    const asRed = seriesScoreOf(series(), 'Alpha', 'Beta');
    assert.equal(seriesScoreLabel(asRed), 'Alpha 2 – 0 Beta');

    // The pair partner swaps seats. The tally does not swap with it.
    const asBlue = seriesScoreOf(series({ firstIsRed: false }), 'Beta', 'Alpha');
    assert.equal(seriesScoreLabel(asBlue), 'Alpha 2 – 0 Beta');
  });

  it('counts drawn games alongside the score', () => {
    const score = seriesScoreOf(series({ draws: 1 }), 'Alpha', 'Beta');
    assert.equal(seriesScoreLabel(score), 'Alpha 2 – 0 Beta · 1 draw');
  });
});
