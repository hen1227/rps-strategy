import assert from 'node:assert/strict';
import test from 'node:test';

import {
  seriesContains,
  seriesGameIsOpen,
  seriesMetaLine,
  seriesStatusTone,
  seriesView,
  watchedOutcome,
  withLiveGame,
  withWatchedResult,
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
    casual: false,
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
    '3 pairs · 3 opening plies · 1+1 · started by ada',
  );
  // A run nobody is attributed to — started with the host token, which is a
  // secret rather than a person — simply says less.
  assert.equal(seriesMetaLine(run({ status: 'running', openingPlies: 0 })), '3 pairs · 1+1');
});

// The shortest clock the form offers is six seconds each, which a run reported
// in whole minutes would round to nothing — and the clock is what says whether
// a 6-0 was two engines thinking or two engines flagging.
test('states a bullet clock rather than rounding it away', () => {
  assert.equal(
    seriesMetaLine(run({ initialTimeMs: 6_000, incrementMs: 1000, openingPlies: 0 })),
    '0 games · 6s+1',
  );
  // An archived row from before the clock was recorded has nothing to say about
  // it, and says nothing rather than "0s+0".
  assert.equal(
    seriesMetaLine(run({ initialTimeMs: 0, incrementMs: 0, openingPlies: 0 })),
    '0 games',
  );
});

test('describes a finished run by what it actually played', () => {
  // Four pairs were asked for and one game happened. Saying "4 pairs" here is
  // the same invention as drawing seven empty columns beside it.
  const stopped = run({
    status: 'aborted',
    pairs: 4,
    games: [game({ gameNumber: 1, result: 'second_win', endReason: 'abandonment' })],
  });
  assert.equal(seriesMetaLine(stopped), '1 game · 3 opening plies · 1+1');
  assert.equal(
    seriesMetaLine(
      run({
        games: [
          game({ gameNumber: 1, result: 'first_win' }),
          game({ gameNumber: 2, result: 'draw' }),
        ],
      }),
    ),
    '2 games · 3 opening plies · 1+1',
  );
});

// A run between two of one person's engines does not move the ladder, and the
// scoreline is exactly where somebody would otherwise wonder why a 6–0 changed
// nothing.
test('says when a run did not count', () => {
  assert.equal(
    seriesMetaLine(run({ casual: true, openingPlies: 0 })),
    '0 games · casual · 1+1',
  );
  // And stays quiet about it on a run that did count, rather than labelling
  // every line with which of the two it is.
  assert.equal(seriesMetaLine(run({ openingPlies: 0 })), '0 games · 1+1');
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

// --- what a watcher can fill in ------------------------------------------
//
// Both of these exist because the server shows a run's news before it files
// it: the result of a game reaches the screen ahead of the row that records it,
// and the next game starts ahead of the row that records *that*. The tests
// below are about the seats, which is where getting this wrong would be
// invisible — a run swaps them every game, so a point awarded backwards looks
// right half the time.

test('reads a colour result as a point for the right engine, either way round', () => {
  // Game one: the first bot is Red.
  assert.equal(watchedOutcome('Red', true), 'first_win');
  assert.equal(watchedOutcome('Blue', true), 'second_win');
  // Game two: the seats have swapped, so the same colours mean the opposite.
  assert.equal(watchedOutcome('Red', false), 'second_win');
  assert.equal(watchedOutcome('Blue', false), 'first_win');
  // Nobody won.
  assert.equal(watchedOutcome('Neutral', true), 'draw');
  assert.equal(watchedOutcome('Neutral', false), 'draw');
});

test('scores the game just watched, and moves the totals with it', () => {
  const before = run({
    status: 'running',
    firstWins: 1,
    secondWins: 0,
    draws: 0,
    games: [game({ gameNumber: 1, result: 'first_win' }), game({ gameNumber: 2 })],
  });
  // Game two is the swapped seating, so Blue is the first bot.
  const after = withWatchedResult(before, {
    gameId: 'g2',
    outcome: watchedOutcome('Blue', false),
    endReason: 'resignation',
  });
  const view = seriesView(after);
  assert.equal(view.games[1].side, 'first');
  assert.equal(view.games[1].firstPoints, '1');
  assert.equal(view.games[1].secondPoints, '0');
  // The column and the totals are the same claim and have to agree.
  assert.equal(view.firstTotal, '2');
  assert.equal(view.secondTotal, '0');
  assert.equal(view.played, 2);
});

test('leaves a game the archive has already scored alone', () => {
  const filed = run({
    firstWins: 0,
    secondWins: 1,
    games: [game({ gameNumber: 1, result: 'second_win' })],
  });
  const after = withWatchedResult(filed, { gameId: 'g1', outcome: 'first_win' });
  assert.equal(after, filed, 'a filed result is the one that counts');
});

test('ignores a result for a game this run has no row for', () => {
  const other = run({ games: [game({ gameNumber: 1 })] });
  assert.equal(withWatchedResult(other, { gameId: 'not-here', outcome: 'draw' }), other);
});

test('gives the board being played right now a column, in playing order', () => {
  const filed = run({
    status: 'running',
    firstWins: 1,
    games: [game({ gameNumber: 1, result: 'first_win' })],
  });
  // Game two is up. The archive has not recorded it yet, and the live row says
  // the first bot is Blue this game.
  const after = withLiveGame(filed, { gameId: 'g2', gameNumber: 2, firstIsRed: false });
  const view = seriesView(after);
  assert.equal(view.games.length, 2);
  assert.equal(view.games[1].number, 2);
  assert.equal(view.games[1].side, 'pending');
  // The seating has to come out of the live row, or the column would name the
  // wrong engine on each side.
  assert.equal(view.games[1].redName, 'Beta');
  assert.equal(view.games[1].blueName, 'Alpha');
  // A pending column is worth watching, which is what puts the live mark on it.
  assert.equal(seriesGameIsOpen(view.games[1], true), true);
  // And it is not a game anybody has played.
  assert.equal(view.played, 1);
  assert.equal(view.firstTotal, '1');
});

test('does not duplicate a live game the archive has caught up with', () => {
  const filed = run({ status: 'running', games: [game({ gameNumber: 1 })] });
  const after = withLiveGame(filed, { gameId: 'g1', gameNumber: 1, firstIsRed: true });
  assert.equal(after, filed);
});

test('sorts a late column into place rather than onto the end', () => {
  // A run whose rows arrive out of order still draws game 2 between 1 and 3.
  const filed = run({
    status: 'running',
    games: [game({ gameNumber: 1, result: 'draw' }), game({ gameNumber: 3 })],
  });
  const after = withLiveGame(filed, { gameId: 'g2', gameNumber: 2, firstIsRed: false });
  assert.deepEqual(
    seriesView(after).games.map((entry) => entry.number),
    [1, 2, 3],
  );
});
