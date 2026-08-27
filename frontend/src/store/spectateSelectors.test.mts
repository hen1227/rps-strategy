import assert from 'node:assert/strict';
import test from 'node:test';

import { isGameLive } from './spectateSelectors.ts';
import type { LiveGameSummary } from '../types/protocol.ts';

const live = (gameId: string) => ({ gameId }) as LiveGameSummary;

// Which of a run's games is being played right now decides where pressing its
// column goes: a live game is watched, a finished one is read back. Getting it
// backwards is what put people on "this game cannot be reviewed" — the live
// game has no archived record yet, because it has not finished.
test('a game in the live list is watched rather than reviewed', () => {
  const games = [live('alpha'), live('beta')];
  assert.equal(isGameLive(games, 'alpha'), true);
  assert.equal(isGameLive(games, 'beta'), true);
  assert.equal(isGameLive(games, 'gamma'), false);
});

test('nothing is live when nothing is being played', () => {
  assert.equal(isGameLive([], 'alpha'), false);
});

// A run stopped mid-game leaves a row with an id and no result. It is not live
// and it cannot be reviewed, so it is neither — and answering "no" here is what
// makes its column inert instead of a broken link.
test('an id that is not on the board is not live', () => {
  assert.equal(isGameLive([live('alpha')], 'orphan'), false);
  assert.equal(isGameLive([live('alpha')], null), false);
  assert.equal(isGameLive([live('alpha')], undefined), false);
});
