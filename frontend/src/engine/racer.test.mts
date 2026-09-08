// The greedy racer: what it reads off a board, and what it plays because of it.
//
// Run with `npm test`. Nothing here touches the engine worker — the racer never
// calls RPSFish, which is the whole claim being tested.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createAnalysisGameFrom, gridFromRows } from './analysisGame';
import {
  RACER_DEFAULTS,
  RACE_WEIGHTS,
  bestRaceMove,
  rankRaceMoves,
  readRace,
  type RacerOptions,
} from './racer';
import { UNREACHABLE } from './reach';
import { testMode } from '@/testing/modes';
import { BOARD_SIZE, type Grid, type SideColor } from '@/types/game';

const V3 = testMode('V3');
const V5 = testMode('V5');

const EMPTY_ROWS = Array.from({ length: BOARD_SIZE }, () => '.'.repeat(BOARD_SIZE));

/** A board with one piece per `place`, everything else empty. */
const board = (...places: [x: number, y: number, symbol: string][]): Grid => {
  const rows = [...EMPTY_ROWS];
  for (const [x, y, symbol] of places) {
    rows[y] = rows[y].slice(0, x) + symbol + rows[y].slice(x + 1);
  }
  return gridFromRows(rows);
};

const game = (grid: Grid, currentTurn: SideColor = 'Red') =>
  createAnalysisGameFrom(V3, grid, currentTurn);

const options = (overrides: Partial<RacerOptions> = {}): RacerOptions => ({
  ...RACER_DEFAULTS,
  ...overrides,
});

describe('readRace', () => {
  it('reads a clear run as the plain distance to the rank', () => {
    // The fixture from `RPSFish/BREAKAWAY.md`: a red rock on e5 with the only
    // blue paper in the far corner is a win in four.
    const reading = readRace(game(board([4, 4, 'r'], [0, 0, 'P'])), 'Red');
    assert.equal(reading.blockedDistance, 4);
    assert.equal(reading.safeDistance, 4);
    assert.equal(reading.clearDistance, 4, 'nothing of its own kind is there to stand in the way');
    assert.equal(reading.safeRunners, 1);
  });

  it('loses the run to a predator that gets there first', () => {
    // The same fixture with the paper on e3, which cuts the run off on d4.
    const reading = readRace(game(board([4, 4, 'r'], [4, 2, 'P'])), 'Red');
    assert.equal(reading.blockedDistance, 4, 'the route is still there');
    assert.equal(reading.safeDistance, null, 'it just cannot be walked');
    assert.equal(reading.safeRunners, 0);
  });

  it('counts a piece that can only block, which the predator reading cannot', () => {
    // A blue rock can neither take a red rock nor be taken by one, so the study
    // tool's threat map never mentions it — and it will still be standing in the
    // corridor. `clearDistance` is the reading that knows.
    const grid = board([4, 4, 'r'], [4, 2, 'R']);
    const reading = readRace(game(grid), 'Red');
    assert.equal(reading.safeDistance, 4, 'no blue paper on the board, so nothing can take it');
    assert.ok(
      reading.clearDistance === null || reading.clearDistance > 4,
      'but something can be in front of it',
    );
  });

  it('orders its three distances', () => {
    // Adding interceptors can only shrink the squares a run may use, so a run
    // nothing can touch is never shorter than one only a predator can cut off,
    // which is never shorter than the bare route.
    const grids = [
      board([4, 4, 'r'], [0, 0, 'P']),
      board([4, 4, 'r'], [4, 2, 'R'], [1, 1, 'P']),
      board([4, 6, 'r'], [4, 2, 'P'], [3, 3, 'R'], [7, 7, 'S']),
      gridFromRows(V3.startingPosition.rows),
    ];
    for (const grid of grids) {
      for (const color of ['Red', 'Blue'] as const) {
        const reading = readRace(game(grid), color);
        const safe = reading.safeDistance ?? UNREACHABLE;
        const clear = reading.clearDistance ?? UNREACHABLE;
        assert.ok(reading.blockedDistance <= safe, `blocked <= safe for ${color}`);
        assert.ok(safe <= clear, `safe <= clear for ${color}`);
      }
    }
  });
});

describe('rankRaceMoves', () => {
  it('has nothing to say in a mode with no goal row', () => {
    const totalWar = createAnalysisGameFrom(V5, gridFromRows(V5.startingPosition.rows), 'Red');
    assert.deepEqual(rankRaceMoves(totalWar), []);
  });

  it('walks onto the rank when the rank is one step away', () => {
    const best = bestRaceMove(game(board([4, 1, 'r'], [0, 8, 'R'])));
    assert.ok(best);
    assert.equal(best.to.y, 0);
    assert.equal(best.decided, 'win');
    assert.equal(best.score, RACE_WEIGHTS.win);
  });

  it('takes the piece that would infiltrate next move', () => {
    // Blue's rock is one step from row 8 and can land on three squares, so no
    // single blocker stops it. Taking it is the only move that survives, and
    // the racer has to see that without searching a ply.
    const grid = board([4, 7, 'R'], [3, 6, 'p'], [0, 4, 'r']);
    const best = bestRaceMove(game(grid));
    assert.ok(best);
    assert.deepEqual({ from: best.from, to: best.to }, { from: { x: 3, y: 6 }, to: { x: 4, y: 7 } });
  });

  it('is a function of the position alone', () => {
    const grid = board([4, 4, 'r'], [2, 2, 'P'], [6, 6, 'S'], [1, 5, 'p'], [7, 3, 'R']);
    const first = rankRaceMoves(game(grid));
    const second = rankRaceMoves(game(grid));
    assert.deepEqual(
      first.map((move) => [move.from, move.to, move.score]),
      second.map((move) => [move.from, move.to, move.score]),
      'no clock, no randomness, no engine — the same board is the same ranking',
    );
  });
});

describe('answerCaptures', () => {
  it('prices the reply that takes the piece it just moved', () => {
    // Two red rocks are running and a blue paper is the only thing that hunts
    // them. Stepping one of them to d4 puts it next to the paper, where it is
    // simply taken — and a race reading cannot see that, because it prices a
    // piece by what it can reach and never tests the square the piece is
    // standing on.
    const grid = board([4, 4, 'r'], [2, 4, 'r'], [2, 2, 'P']);
    const hanging = { from: { x: 2, y: 4 }, to: { x: 3, y: 3 } };
    const scoreOf = (racer: RacerOptions) => {
      const move = rankRaceMoves(game(grid), racer).find(
        (candidate) =>
          candidate.from.x === hanging.from.x &&
          candidate.from.y === hanging.from.y &&
          candidate.to.x === hanging.to.x &&
          candidate.to.y === hanging.to.y,
      );
      assert.ok(move, 'the move exists either way');
      return move;
    };

    const guarded = scoreOf(options({ answerCaptures: true }));
    const blind = scoreOf(options({ answerCaptures: false }));
    assert.ok(
      guarded.score < blind.score,
      'the guard is what makes walking into a capture look as bad as it is',
    );
    assert.ok(guarded.rank > blind.rank, 'and it moves the move down the ranking');
  });
});
