import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  SHARE_IS_MEANINGFUL_AT,
  arrowWeights,
  formatShare,
  hasEnoughGames,
  openingScoreline,
  type OpeningStatsExploredMove,
  type OpeningStatsLine,
} from './openingStats';

const line = (over: Partial<OpeningStatsLine> = {}): OpeningStatsLine => ({
  line: ['d2-c3'],
  move: 'd2-c3',
  games: 10,
  share: 0.5,
  shareOfParent: 0.5,
  redWins: 5,
  blueWins: 4,
  draws: 1,
  lastPlayedUnixMs: 0,
  ...over,
});

describe('formatShare', () => {
  it('keeps a decimal place only where the number carries one', () => {
    // A share is a sample. Below ten percent the tenths distinguish rows that
    // would otherwise read alike; above it they claim a resolution the sample
    // does not have.
    assert.equal(formatShare(0.009), '0.9%');
    assert.equal(formatShare(0.0384), '3.8%');
    assert.equal(formatShare(0.384), '38%');
    assert.equal(formatShare(1), '100%');
  });

  it('does not draw a bar for nothing', () => {
    assert.equal(formatShare(0), '0%');
    assert.equal(formatShare(-1), '0%');
    assert.equal(formatShare(Number.NaN), '0%');
  });
});

describe('openingScoreline', () => {
  it('splits the decided games three ways', () => {
    const split = openingScoreline(line({ redWins: 3, blueWins: 1, draws: 0 }));
    assert.ok(split);
    assert.equal(split.redShare, 0.75);
    assert.equal(split.blueShare, 0.25);
    assert.equal(split.drawShare, 0);
  });

  it('reports nothing when no game finished, rather than an empty bar', () => {
    // The caller leaves the bar out on null. Returning zeroes would have it
    // draw a scoreline for games that have not happened.
    assert.equal(openingScoreline(line({ redWins: 0, blueWins: 0, draws: 0 })), null);
  });
});

describe('hasEnoughGames', () => {
  it('is a presentation threshold, not a statistical one', () => {
    // Below this a percentage is really a count wearing a percent sign, and
    // the panel shows the count instead.
    assert.equal(hasEnoughGames(SHARE_IS_MEANINGFUL_AT - 1), false);
    assert.equal(hasEnoughGames(SHARE_IS_MEANINGFUL_AT), true);
    assert.equal(hasEnoughGames(0), false);
  });
});

describe('arrowWeights', () => {
  const move = (games: number): OpeningStatsExploredMove => ({
    move: 'd2-c3',
    games,
    share: 0,
    shareOfAll: 0,
    redWins: 0,
    blueWins: 0,
    draws: 0,
  });

  it('scales against the most played move, not against every game', () => {
    // A board where every continuation is rare still has a commonest one, and
    // that is what the thickest arrow has to mean. Scaling against 1 would
    // draw all five of these almost invisibly.
    assert.deepEqual(arrowWeights([move(4), move(2), move(1)]), [1, 0.5, 0.25]);
  });

  it('draws a lone move at full weight', () => {
    // It is the only thing anybody did, so it is the most played.
    assert.deepEqual(arrowWeights([move(1)]), [1]);
  });

  it('has nothing to scale when nothing was played', () => {
    assert.deepEqual(arrowWeights([]), []);
    assert.deepEqual(arrowWeights([move(0), move(0)]), [0, 0]);
  });
});
