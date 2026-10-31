import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  COUNT_GAP_MS,
  COUNT_START_MS,
  finishCountPlan,
  ownedSquares,
  ratingChangeFor,
  tallySides,
} from './finishCount.ts';
import type { Grid, PlayerColor } from '@/types/game';

describe('the finished card counting out', () => {
  it('waits for the result to be read, then counts the tally, then the rating', () => {
    const plan = finishCountPlan({ tally: 5, rating: { before: 1500, after: 1512 } });
    assert.equal(plan.tally.length, 5);
    assert.ok(plan.tally[0]!.atMs > COUNT_START_MS);
    assert.equal(plan.tally.at(-1)?.value, 5);
    assert.ok(plan.rating[0]!.atMs > plan.tally.at(-1)!.atMs + COUNT_GAP_MS);
    assert.equal(plan.rating.length, 12);
    assert.equal(plan.rating.at(-1)?.value, 1512);
  });

  it('goes straight to the rating when there is nothing to tally', () => {
    const plan = finishCountPlan({ tally: 0, rating: { before: 1500, after: 1491 } });
    assert.deepEqual(plan.tally, []);
    assert.ok(plan.rating[0]!.atMs > COUNT_START_MS);
    assert.equal(plan.rating.at(-1)?.value, 1491);
  });

  it('counts nothing for an unrated game that took nothing', () => {
    assert.deepEqual(finishCountPlan({ tally: 0, rating: null }), { tally: [], rating: [] });
  });

  it('finishes inside two seconds however much there is to count', () => {
    const plan = finishCountPlan({ tally: 81, rating: { before: 1200, after: 1450 } });
    assert.ok(plan.rating.at(-1)!.atMs < 2000);
  });
});

describe('whose rating the card shows', () => {
  const update = {
    gameId: 'g',
    recorded: true,
    ranked: true,
    modeId: 'V6',
    redEloBefore: 1500,
    redEloAfter: 1512,
    blueEloBefore: 1490,
    blueEloAfter: 1478,
  } as const;

  it('is the reader’s own side', () => {
    assert.deepEqual(ratingChangeFor(update as never, 'g', 'Red'), { before: 1500, after: 1512 });
    assert.deepEqual(ratingChangeFor(update as never, 'g', 'Blue'), { before: 1490, after: 1478 });
  });

  it('is nothing for a casual game, a spectator, or another game', () => {
    assert.equal(ratingChangeFor({ ...update, ranked: false } as never, 'g', 'Red'), null);
    assert.equal(ratingChangeFor({ ...update, recorded: false } as never, 'g', 'Red'), null);
    assert.equal(ratingChangeFor(update as never, 'g', 'Neutral'), null);
    assert.equal(ratingChangeFor(update as never, 'h', 'Red'), null);
    assert.equal(ratingChangeFor(null, 'g', 'Red'), null);
  });
});

describe('the tally', () => {
  const owner = (color: PlayerColor) => ({
    occupant: 'Empty',
    occupantOwner: 'Neutral',
    ownerColor: color,
    x: 0,
    y: 0,
  });

  it('counts the squares each side owns', () => {
    const grid = [
      [owner('Red'), owner('Blue'), owner('Neutral')],
      [owner('Red'), owner('Red'), owner('Blue')],
    ] as unknown as Grid;
    assert.deepEqual(ownedSquares(grid), { Red: 3, Blue: 2 });
  });

  it('starts from the reader’s side, or Blue’s at a shared board', () => {
    assert.deepEqual(tallySides('Red'), ['Red', 'Blue']);
    assert.deepEqual(tallySides('Blue'), ['Blue', 'Red']);
    assert.deepEqual(tallySides(null), ['Blue', 'Red']);
  });
});
