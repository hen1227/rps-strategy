import assert from 'node:assert/strict';
import test from 'node:test';

import {
  seriesContains,
  seriesGameIsOpen,
  seriesMetaLine,
  seriesStatusTone,
  seriesView,
} from './seriesSummary.ts';
import type { BotSeries, BotSeriesGame } from '../../store/api/bots.ts';

const game = (over: Partial<BotSeriesGame> & { gameNumber: number }): BotSeriesGame => ({
  pairNumber: Math.ceil(over.gameNumber / 2),
  swapped: over.gameNumber % 2 === 0,
  gameId: `g${over.gameNumber}`,
  result: 'pending',
  ...over,
});

const run = (over: Partial<BotSeries> = {}): BotSeries =>
  ({
    seriesId: 's1',
    modeId: 'V3',
    firstBotId: 'first-bot',
    secondBotId: 'second-bot',
    firstBotName: 'Alpha',
    secondBotName: 'Beta',
    status: 'completed',
    pairs: 3,
    openingPlies: 3,
    seed: '99',
    initialTimeMs: 60_000,
    incrementMs: 1000,
    firstWins: 0,
    secondWins: 0,
    draws: 0,
    games: [],
    createdAtUnixMs: 1,
    ...over,
  }) as BotSeries;

test('scores a run from the first bot, whichever seat it held', () => {
  const view = seriesView(
    run({
      firstWins: 4,
      secondWins: 1,
      draws: 1,
      games: [
        game({ gameNumber: 1, result: 'first_win', endReason: 'infiltration' }),
        game({ gameNumber: 2, result: 'first_win', endReason: 'resignation' }),
        game({ gameNumber: 3, result: 'second_win', endReason: 'timeout' }),
        game({ gameNumber: 4, result: 'draw', endReason: 'move_limit' }),
        game({ gameNumber: 5, result: 'first_win', endReason: 'annihilation' }),
        game({ gameNumber: 6, result: 'first_win', endReason: 'territory' }),
      ],
    }),
  );
  // Halves are written as halves. Four wins and a draw is four and a half.
  assert.equal(view.firstTotal, '4½');
  assert.equal(view.secondTotal, '1½');
  // A point sits under the game in the winner's row. Game 2 was played with the
  // seats swapped and still scores for the first bot, which is the whole reason
  // results are stored from one side rather than by colour.
  assert.deepEqual(
    view.games.map((entry) => `${entry.firstPoints}/${entry.secondPoints}`),
    ['1/0', '1/0', '0/1', '½/½', '1/0', '1/0'],
  );
  assert.equal(view.played, 6);
  // Finished, so there is no plan left to report.
  assert.equal(view.planned, null);
});

test('a running run says how many games it still has to play', () => {
  const view = seriesView(
    run({
      status: 'running',
      pairs: 3,
      firstWins: 1,
      games: [game({ gameNumber: 1, result: 'first_win', endReason: 'resignation' })],
    }),
  );
  assert.equal(view.planned, 6);
  assert.equal(view.played, 1);
});

test('names the bot that walked away, and says who was given the game', () => {
  const view = seriesView(
    run({
      firstWins: 1,
      secondWins: 1,
      games: [
        // The first bot won, so it was the second bot that left.
        game({ gameNumber: 1, result: 'first_win', endReason: 'abandonment' }),
        game({ gameNumber: 2, result: 'second_win', endReason: 'abandonment' }),
        game({ gameNumber: 3, result: 'draw', endReason: 'move_limit' }),
      ],
    }),
  );
  assert.equal(view.games[0]?.abandonedBy, 'Beta');
  assert.equal(view.games[1]?.abandonedBy, 'Alpha');
  assert.equal(view.games[2]?.abandonedBy, null);
  assert.deepEqual(
    view.abandoned.map((entry) => entry.number),
    [1, 2],
  );
  assert.equal(view.games[0]?.label, 'Game 1: Beta abandoned');
});

test('a run stopped early reports only what it played', () => {
  const view = seriesView(
    run({
      status: 'aborted',
      pairs: 3,
      firstWins: 1,
      games: [
        game({ gameNumber: 1, result: 'first_win', endReason: 'resignation' }),
        game({ gameNumber: 2, result: 'pending', gameId: '' }),
      ],
    }),
  );
  assert.equal(view.played, 1);
  // Not "1 of 6". The three pairs it never started were never written down, so
  // reporting them would mean inventing games that read as losses.
  assert.equal(view.planned, null);
  assert.equal(view.games[1]?.firstPoints, '·');
  assert.equal(view.games[1]?.secondPoints, '·');
  // A game that never started cannot be reviewed, so it carries no id for the
  // chip to open.
  assert.equal(view.games[1]?.gameId, null);
  assert.equal(view.games[1]?.label, 'Game 2: not played yet');
});

test('falls back to a name for an engine whose account is gone', () => {
  const view = seriesView(run({ firstBotName: undefined, secondBotName: '' }));
  assert.equal(view.firstName, 'First bot');
  assert.equal(view.secondName, 'Second bot');
});

test('describes a running run by what it set out to play', () => {
  assert.equal(
    seriesMetaLine(run({ status: 'running', requestedByName: 'ada' })),
    '3 pairs · 3 opening plies · 1 min · started by ada',
  );
  // A run nobody is attributed to — started with the host token, which is a
  // secret rather than a person — simply says less.
  assert.equal(seriesMetaLine(run({ status: 'running', openingPlies: 0 })), '3 pairs · 1 min');
});

test('describes a finished run by what it actually played', () => {
  // Four pairs were asked for and one game happened. Saying "4 pairs" here is
  // the same invention as drawing seven empty columns beside it.
  const stopped = run({
    status: 'aborted',
    pairs: 4,
    games: [game({ gameNumber: 1, result: 'second_win', endReason: 'abandonment' })],
  });
  assert.equal(seriesMetaLine(stopped), '1 game · 3 opening plies · 1 min');
  assert.equal(
    seriesMetaLine(
      run({
        games: [
          game({ gameNumber: 1, result: 'first_win' }),
          game({ gameNumber: 2, result: 'draw' }),
        ],
      }),
    ),
    '2 games · 3 opening plies · 1 min',
  );
});

test('knows which games belong to a run', () => {
  const played = run({
    games: [
      game({ gameNumber: 1, result: 'first_win' }),
      game({ gameNumber: 2, result: 'pending' }),
    ],
  });
  // The live game being game two of this run is what keeps the chat on screen
  // while somebody looks back at game one: they are the same room.
  assert.equal(seriesContains(played, 'g2'), true);
  assert.equal(seriesContains(played, 'g9'), false);
  assert.equal(seriesContains(played, null), false);
  assert.equal(seriesContains(null, 'g1'), false);
  // A row with no id is a game that never started, and matches nothing — least
  // of all another game that also has no id.
  assert.equal(seriesContains(run({ games: [game({ gameNumber: 1, gameId: '' })] }), ''), false);
});

test('every game says which engine held which seat', () => {
  const view = seriesView(
    run({
      games: [
        game({ gameNumber: 1, result: 'first_win', endReason: 'infiltration' }),
        game({ gameNumber: 2, result: 'first_win', endReason: 'infiltration' }),
      ],
    }),
  );
  // The second game of a pair is the same opening with the colours exchanged,
  // which is the whole reason a run's score means anything. Both games went to
  // Alpha, from opposite sides of the board.
  assert.deepEqual(
    view.games.map((entry) => `${entry.redName} v ${entry.blueName}`),
    ['Alpha v Beta', 'Beta v Alpha'],
  );
});

test('a game is only openable when there is something behind it', () => {
  const view = seriesView(
    run({
      status: 'aborted',
      games: [
        game({ gameNumber: 1, result: 'first_win', endReason: 'resignation' }),
        game({ gameNumber: 2 }),
        game({ gameNumber: 3, gameId: '' }),
      ],
    }),
  );
  const [decided, unfinished, never] = view.games;
  // A finished game has a record to read back.
  assert.equal(seriesGameIsOpen(decided!, false), true);
  // The game a stopped run was in the middle of has neither a record nor a
  // board — unless it is still being played, which only the live list knows.
  assert.equal(seriesGameIsOpen(unfinished!, false), false);
  assert.equal(seriesGameIsOpen(unfinished!, true), true);
  // A game that never started has no id at all, live or not.
  assert.equal(seriesGameIsOpen(never!, true), false);
});

test('a run badges its own state', () => {
  assert.equal(seriesStatusTone(run({ status: 'running' })), 'live');
  assert.equal(seriesStatusTone(run({ status: 'completed' })), 'accent');
  assert.equal(seriesStatusTone(run({ status: 'aborted' })), 'neutral');
  // Anything the server invents later reads as neutral rather than as nothing.
  assert.equal(seriesStatusTone(run({ status: 'paused' })), 'neutral');
});
