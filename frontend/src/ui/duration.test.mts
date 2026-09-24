import assert from 'node:assert/strict';
import test from 'node:test';

import { daysBetween, formatDays, formatSpan } from './duration.ts';

const DAY = 24 * 60 * 60 * 1000;

test('a span is counted in whole days', () => {
  assert.equal(daysBetween(0, 0), 0);
  assert.equal(daysBetween(0, DAY - 1), 0);
  assert.equal(daysBetween(0, DAY), 1);
  assert.equal(daysBetween(0, 24 * DAY + DAY / 2), 24);
});

test('a reign that has not lasted a day reads as today, not as zero', () => {
  assert.equal(formatDays(0), 'today');
  assert.equal(formatSpan(0, DAY - 1), 'today');
});

test('one day is singular', () => {
  assert.equal(formatSpan(0, DAY), '1 day');
  assert.equal(formatSpan(0, 2 * DAY), '2 days');
});

// Clocks disagree: the timestamp is the server's and `now` is the reader's
// device, so a reign recorded seconds ago can arrive looking like the future.
// "-0 days" on the ladder would be read as a bug in the ladder.
test('a clock running backwards reads as today rather than as negative', () => {
  assert.equal(daysBetween(DAY, 0), 0);
  assert.equal(formatSpan(10 * DAY, 0), 'today');
});

// A long reign is the answer somebody came for, so it is not rounded away.
test('a long reign keeps its number', () => {
  assert.equal(formatSpan(0, 400 * DAY), '400 days');
});
