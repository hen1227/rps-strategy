import assert from 'node:assert/strict';
import test from 'node:test';

import { colourResultLabel, endReasonPhrase, namedResultLabel } from './resultLabels.ts';

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
