import assert from 'node:assert/strict';
import test from 'node:test';

import {
  colourResultLabel,
  endReasonPhrase,
  namedResultLabel,
  namedResultSegments,
  recordResultLabel,
  recordResultSegments,
  resultForPlayer,
} from './resultLabels.ts';
import type { GameRecord } from '@/types/protocol';

test('a result names how the game ended when the reason says something', () => {
  assert.equal(colourResultLabel('Red', 'annihilation'), 'Red wins by annihilation');
  assert.equal(colourResultLabel('Neutral', 'repetition'), 'Draw by threefold repetition');
  // `game_rule` is the server's fallback for "the mode decided", so spelling it
  // out would put noise where the reader wants a reason or nothing.
  assert.equal(colourResultLabel('Blue', 'game_rule'), 'Blue wins');
  assert.equal(colourResultLabel('Blue', null), 'Blue wins');
  assert.equal(endReasonPhrase('timeout'), 'time');
  assert.equal(endReasonPhrase('nonsense'), undefined);
});

test('a named result puts the winner first, whichever seat they held', () => {
  const seats = { redName: 'Alpha', blueName: 'Beta' };
  assert.equal(
    namedResultLabel({ ...seats, winnerName: 'Beta', endReason: 'territory' }),
    'Beta beat Alpha by territory',
  );
  assert.equal(
    namedResultLabel({ ...seats, winnerName: 'Alpha', endReason: 'timeout' }),
    'Alpha beat Beta by time',
  );
});

test('a draw names both bots in the order they sat', () => {
  assert.equal(
    namedResultLabel({
      redName: 'Alpha',
      blueName: 'Beta',
      winnerName: null,
      endReason: 'stalemate',
    }),
    'Alpha and Beta drew by stalemate',
  );
  assert.equal(
    namedResultLabel({ redName: 'Alpha', blueName: 'Beta', winnerName: null, endReason: null }),
    'Alpha and Beta drew',
  );
});

// The fields these helpers read, from a record the server filed.
const storedGame = (overrides: Partial<GameRecord> = {}): GameRecord =>
  ({
    gameId: 'g1',
    modeId: 'classic',
    modeName: 'Classic',
    redPlayer: { userId: 'red-id', username: 'Alpha' },
    bluePlayer: { userId: 'blue-id', username: 'Beta' },
    winnerUserId: 'red-id',
    winnerColor: 'Red',
    outcome: 'red_win',
    endReason: 'annihilation',
    ranked: true,
    moveNumber: 21,
    initialTimeMs: 0,
    incrementMs: 0,
    startedAtUnixMs: 0,
    finishedAtUnixMs: 0,
    ...overrides,
  }) as GameRecord;

test('a stored game reads the same way a named result does', () => {
  assert.equal(recordResultLabel(storedGame()), 'Alpha beat Beta by annihilation');
  assert.equal(
    recordResultLabel(storedGame({ winnerUserId: null, endReason: 'move_limit' })),
    'Alpha and Beta drew by move limit',
  );
});

test('a result line is cut so that both names are pieces of their own', () => {
  // The two names have to come out whole and separate: they are what a row
  // links, and a name half-buried in a phrase cannot be one.
  assert.deepEqual(
    namedResultSegments({
      redName: 'Alpha',
      blueName: 'Beta',
      winnerName: 'Beta',
      endReason: 'territory',
    }),
    [
      { text: 'Beta', isName: true },
      { text: ' beat ', isName: false },
      { text: 'Alpha', isName: true },
      { text: ' by territory', isName: false },
    ],
  );
  // A game that ended for no reason worth naming leaves no tail rather than an
  // empty piece, which would draw as a `Text` with nothing in it.
  assert.deepEqual(
    namedResultSegments({
      redName: 'Alpha',
      blueName: 'Beta',
      winnerName: 'Alpha',
      endReason: 'game_rule',
    }),
    [
      { text: 'Alpha', isName: true },
      { text: ' beat ', isName: false },
      { text: 'Beta', isName: true },
    ],
  );
});

test('the pieces of a result line join back into the sentence', () => {
  // The drawn line and the read-out line come from one place, so a row cannot
  // say something different from what it announces.
  for (const record of [
    storedGame(),
    storedGame({ winnerUserId: 'blue-id', winnerColor: 'Blue' }),
    storedGame({ winnerUserId: null, endReason: 'move_limit' }),
    storedGame({ endReason: 'game_rule' }),
  ]) {
    assert.equal(
      recordResultSegments(record)
        .map((part) => part.text)
        .join(''),
      recordResultLabel(record),
    );
  }
});

test('a game is a win, a loss or a draw only for whoever was seated in it', () => {
  const game = storedGame();
  assert.equal(resultForPlayer(game, 'red-id'), 'win');
  assert.equal(resultForPlayer(game, 'blue-id'), 'loss');
  // A reader who opened a shared link played neither side, and "not a win" is
  // not a loss.
  assert.equal(resultForPlayer(game, 'someone-else'), 'unknown');
  assert.equal(resultForPlayer(storedGame({ winnerUserId: null }), 'blue-id'), 'draw');
});
