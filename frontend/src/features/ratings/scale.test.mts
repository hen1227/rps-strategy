import assert from 'node:assert/strict';
import test from 'node:test';

import {
  RATING_SYSTEM,
  RATING_UNRATED_LABEL,
  RATING_UNRATED_SHORT,
  archivedRatingCaveat,
  ratingCaveat,
  ratingIsRankable,
  ratingLabel,
  ratingOdds,
  ratingWinChance,
} from './scale.ts';

test('an unrated row shows no number, because 1 is a real measurement', () => {
  assert.equal(ratingLabel(1, 'unrated'), RATING_UNRATED_SHORT);
  assert.equal(ratingCaveat('unrated'), RATING_UNRATED_LABEL);
  assert.equal(ratingIsRankable('unrated'), false);
});

test('a rating the record actually placed at the floor keeps its number', () => {
  // The whole point of separating the two: "plays no better than chance" is a
  // finding, and it prints as 1.
  assert.equal(ratingLabel(1, 'rated'), '1');
  assert.equal(ratingCaveat('rated'), null);
  assert.equal(ratingIsRankable('rated'), true);
});

test('a provisional rating shows its number and says it is still moving', () => {
  assert.equal(ratingLabel(240, 'provisional'), '240');
  assert.match(ratingCaveat('provisional') ?? '', /Provisional/);
  assert.equal(ratingIsRankable('provisional'), true);
});

test('a missing state is treated as a rating', () => {
  // A server older than the field cannot say otherwise, and hiding every number
  // on it would be worse than the ambiguity this replaces.
  assert.equal(ratingLabel(88, undefined), '88');
  assert.equal(ratingCaveat(undefined), null);
  assert.equal(ratingIsRankable(undefined), true);
});

test('the scale still reads as odds', () => {
  assert.equal(ratingWinChance(21, 1), 2 / 3);
  assert.equal(ratingOdds(21, 1), '2.0 to 1');
  assert.equal(ratingOdds(1, 1), 'even');
});

test("a record on today's scale says only that its ratings are from then", () => {
  const note = archivedRatingCaveat(RATING_SYSTEM);
  assert.match(note, /at the time of this game/);
  assert.doesNotMatch(note, /1200/);
});

test('a record from before the rebuild says which scale its ratings are on', () => {
  // The numbers in one of these are chess Elo centred on 1200 and look exactly
  // like today's, so the untagged case is the one that has to speak up.
  assert.match(archivedRatingCaveat(null), /1200-centred/);
  assert.match(archivedRatingCaveat('elo/1200'), /cannot be compared/);
});
