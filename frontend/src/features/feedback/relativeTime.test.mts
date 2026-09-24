// The age of a row, which on this board is most of what it means.
//
// Worth pinning because the boundaries are where a rounding function reads
// wrong and nobody notices: "0m ago" for something posted seconds back, "24h
// ago" for yesterday, or a negative age for a row whose timestamp is a second
// ahead of a browser clock that is a second behind.

import assert from 'node:assert/strict';
import test from 'node:test';

import { timeAgo } from './relativeTime.ts';

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const NOW = 1_757_000_000_000;
const ago = (elapsed: number) => timeAgo(NOW - elapsed, NOW);

test('the first minute is "just now" rather than "0m ago"', () => {
  assert.equal(ago(0), 'just now');
  assert.equal(ago(59 * SECOND), 'just now');
  assert.equal(ago(MINUTE), '1m ago');
});

test('each unit hands over to the next at its own boundary', () => {
  assert.equal(ago(59 * MINUTE), '59m ago');
  assert.equal(ago(HOUR), '1h ago');
  assert.equal(ago(23 * HOUR), '23h ago');
  assert.equal(ago(DAY), '1d ago');
  assert.equal(ago(6 * DAY), '6d ago');
  assert.equal(ago(7 * DAY), '1w ago');
  assert.equal(ago(59 * DAY), '8w ago');
  assert.equal(ago(60 * DAY), '2mo ago');
});

test('a timestamp from the future reads as now, not as a negative age', () => {
  // Two clocks are involved — the server stamps the row and the browser reads
  // it — so a row a few seconds "ahead" is ordinary rather than a fault. What
  // must not happen is the board saying "-1m ago".
  assert.equal(timeAgo(NOW + 5 * SECOND, NOW), 'just now');
  assert.equal(timeAgo(NOW + DAY, NOW), 'just now');
});
