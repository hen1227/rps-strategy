import assert from 'node:assert/strict';
import test from 'node:test';

import type { ModeRating } from '../../types/protocol.ts';
import {
  ANCHORED_RATING_SYSTEM,
  RATING_START,
  RATING_SYSTEM,
  RATING_UNRATED_LABEL,
  RATING_UNRATED_SHORT,
  archivedRatingCaveat,
  headlineRating,
  ratingCaveat,
  ratingIsRankable,
  ratingLabel,
} from './scale.ts';

test('an unrated row shows no number, because the starting number was not earned', () => {
  assert.equal(ratingLabel(RATING_START, 'unrated'), RATING_UNRATED_SHORT);
  assert.equal(ratingCaveat('unrated'), RATING_UNRATED_LABEL);
  assert.equal(ratingIsRankable('unrated'), false);
});

test('a settled rating shows its number and nothing else', () => {
  assert.equal(ratingLabel(1712, 'rated'), '1712');
  assert.equal(ratingCaveat('rated'), null);
  assert.equal(ratingIsRankable('rated'), true);
});

test('a provisional rating shows its number and says it is still moving', () => {
  assert.equal(ratingLabel(1304, 'provisional'), '1304');
  assert.match(ratingCaveat('provisional') ?? '', /Provisional/);
  assert.equal(ratingIsRankable('provisional'), true);
});

test('a missing state is treated as a rating', () => {
  // A server older than the field cannot say otherwise, and hiding every number
  // on it would be worse than showing one that has not been earned yet.
  assert.equal(ratingLabel(1488, undefined), '1488');
  assert.equal(ratingCaveat(undefined), null);
  assert.equal(ratingIsRankable(undefined), true);
});

test("a record on today's scale says only that its ratings are from then", () => {
  const note = archivedRatingCaveat(RATING_SYSTEM);
  assert.match(note, /at the time of this game/);
  assert.doesNotMatch(note, /cannot be compared/);
});

test('a record from either earlier scale says which one its ratings are on', () => {
  // Every scale this site has used prints numbers that look like ratings, so
  // the older records are the ones that have to speak up.
  assert.match(archivedRatingCaveat(ANCHORED_RATING_SYSTEM), /random/);
  assert.match(archivedRatingCaveat(ANCHORED_RATING_SYSTEM), /cannot be compared/);
  assert.match(archivedRatingCaveat(null), /1200-centred/);
  assert.match(archivedRatingCaveat('elo/1200'), /cannot be compared/);
});

const mode = (modeId: ModeRating['modeId'], elo: number, ratingState: ModeRating['ratingState']): ModeRating => ({
  modeId,
  elo,
  wins: 0,
  losses: 0,
  draws: 0,
  gamesPlayed: 10,
  updatedAtUnixMs: 0,
  ratingState,
});

test("an account's headline is its best rated mode", () => {
  assert.deepEqual(
    headlineRating({
      V5: mode('V5', 1490, 'rated'),
      V6: mode('V6', 1620, 'provisional'),
      V3: mode('V3', 1900, 'unrated'),
    }),
    { elo: 1620, state: 'provisional', modeId: 'V6' },
  );
});

test('an account with no ranked game anywhere is unrated at the start', () => {
  assert.deepEqual(headlineRating({ V6: mode('V6', RATING_START, 'unrated') }), {
    elo: RATING_START,
    state: 'unrated',
    modeId: null,
  });
  assert.deepEqual(headlineRating(undefined), { elo: RATING_START, state: 'unrated', modeId: null });
});
