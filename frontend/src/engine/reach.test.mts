// The reach maps and the race they add up to.
//
// Run with `npm test`. Nothing here touches the engine worker: every number
// below is decided by the movement rule and a breadth-first walk, which is the
// whole point of the module.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { gridFromRows, type PositionLike } from './analysisGame';
import {
  UNREACHABLE,
  analyzeReach,
  distanceToRow,
  goalRowFor,
  predators,
  reachMap,
  safeRun,
  supportsReachRace,
  threatMap,
  walkersOn,
  type ObstacleModel,
  type ReachOptions,
  type RunOptions,
  type Walker,
} from './reach';
import { testMode } from '@/testing/modes';
import { BOARD_SIZE, type Grid, type SideColor } from '@/types/game';

const V3 = testMode('V3');
const V5 = testMode('V5');

const position = (rows: string[], currentTurn: SideColor = 'Red'): PositionLike => ({
  grid: gridFromRows(rows),
  currentTurn,
  mode: V3,
  moveNumber: 0,
});

const redRock = (x: number, y: number): Walker => ({
  from: { x, y },
  piece: 'Rock',
  owner: 'Red',
});

const runOptions = (overrides: Partial<RunOptions> = {}): RunOptions => ({
  obstacles: 'static',
  safety: 'perStep',
  walkerToMove: true,
  goalEndsGame: true,
  ...overrides,
});

const reachOptions = (overrides: Partial<ReachOptions> = {}): ReachOptions => ({
  obstacles: 'static',
  safety: 'perStep',
  goalEndsGame: true,
  toMove: 'Red',
  ...overrides,
});

const EMPTY_ROWS = Array.from({ length: BOARD_SIZE }, () => '.'.repeat(BOARD_SIZE));

/** A board with one piece per `place`, everything else empty. */
const board = (...places: [x: number, y: number, symbol: string][]): Grid => {
  const rows = [...EMPTY_ROWS];
  for (const [x, y, symbol] of places) {
    rows[y] = rows[y].slice(0, x) + symbol + rows[y].slice(x + 1);
  }
  return gridFromRows(rows);
};

/**
 * A sealed single-file corridor with one red rock in it.
 *
 * Red's goal is row 0, and the walls run the full height of the board so that
 * the four steps up file `e` are the *only* route there — which is what lets a
 * test say "this run is cut off" and mean it rather than measuring a detour.
 * Row 0 is left open so no wall piece is standing on the goal already.
 *
 * The walls are red rocks rather than scissors on purpose: a blue paper eats
 * rocks, so the hunter can still come through. Sealing the runner in without
 * also sealing the hunter out is the whole point.
 */
const corridor = (...extra: [x: number, y: number, symbol: string][]): Grid =>
  board(
    ...([1, 2, 3, 5, 6, 7, 8].flatMap(
      (y): [number, number, string][] => [[3, y, 'r'], [5, y, 'r']],
    )),
    [3, 4, 'r'], [4, 4, 'r'], [5, 4, 'r'],
    ...extra,
  );

const CORRIDOR_RUNNER = redRock(4, 4);

describe('reachMap', () => {
  it('is Chebyshev distance when it ignores the pieces', () => {
    const map = reachMap(board([4, 4, 'r']), redRock(4, 4), 'open');
    for (let y = 0; y < BOARD_SIZE; y += 1) {
      for (let x = 0; x < BOARD_SIZE; x += 1) {
        assert.equal(map[y][x], Math.max(Math.abs(x - 4), Math.abs(y - 4)), `${x},${y}`);
      }
    }
  });

  it('walks through the one enemy kind it captures, and around the other two', () => {
    // A red rock takes scissors, loses to paper, and ties with a rock.
    const grid = board([4, 4, 'r'], [4, 3, 'S'], [3, 3, 'P'], [5, 3, 'R']);
    const map = reachMap(grid, redRock(4, 4), 'static');

    assert.equal(map[3][4], 1, 'steps onto the scissors it captures');
    assert.equal(map[3][3], UNREACHABLE, 'never onto the paper that captures it');
    assert.equal(map[3][5], UNREACHABLE, 'never onto a rock of either colour');
    assert.equal(map[2][3], 2, 'a blocker blocks its own square, not the ones behind it');
  });

  it('is blocked by its own side until the friendly pieces are assumed to move', () => {
    const grid = gridFromRows([
      ...EMPTY_ROWS.slice(0, 7),
      'rrrrrrrrr',
      '....r....',
    ]);
    const walker = redRock(4, 8);

    assert.equal(distanceToRow(reachMap(grid, walker, 'static'), 0), UNREACHABLE);
    assert.equal(distanceToRow(reachMap(grid, walker, 'friendlyVacates'), 0), 8);
    assert.equal(distanceToRow(reachMap(grid, walker, 'open'), 0), 8);
  });
});

describe('predators and threat', () => {
  it('finds the one enemy kind that captures this one', () => {
    const grid = board([4, 4, 'r'], [0, 0, 'P'], [8, 8, 'P'], [1, 1, 'S'], [2, 2, 'p']);
    const found = predators(grid, redRock(4, 4));

    assert.equal(found.length, 2, 'both blue papers, and nothing else');
    assert.deepEqual(
      found.map(({ from }) => from),
      [{ x: 0, y: 0 }, { x: 8, y: 8 }],
      'in board order',
    );
  });

  it('is the nearest predator, square by square', () => {
    const grid = board([4, 4, 'r'], [0, 0, 'P'], [8, 8, 'P']);
    const map = threatMap(grid, redRock(4, 4), 'open');

    assert.equal(map[4][4], 4, 'either paper is four steps from the rock');
    assert.equal(map[1][1], 1, 'the near one owns its own corner');
    assert.equal(map[7][7], 1, 'and the far one owns the other');
  });

  it('is empty when the enemy has no piece of that kind left', () => {
    const grid = board([4, 4, 'r'], [0, 0, 'S'], [8, 8, 'R']);
    const map = threatMap(grid, redRock(4, 4), 'static');

    assert.equal(predators(grid, redRock(4, 4)).length, 0);
    assert.ok(map.every((row) => row.every((cell) => cell === UNREACHABLE)));
  });
});

describe('safeRun', () => {
  it('takes the corridor when no predator can get in front of it', () => {
    const run = safeRun(corridor([8, 0, 'P']), CORRIDOR_RUNNER, 0, runOptions());

    assert.ok(run, 'the run exists');
    assert.equal(run.moves, 4);
    // The corridor is forced; which of the three goal squares it steps out onto
    // is a tie the walk breaks arbitrarily, so only the corridor is asserted.
    assert.deepEqual(run.path.slice(0, 4).map(({ x, y }) => `${x},${y}`), [
      '4,4', '4,3', '4,2', '4,1',
    ]);
    assert.equal(run.path.at(-1)?.y, 0, 'and it finishes on the goal row');
  });

  it('is cut off when the same predator starts one square nearer', () => {
    const grid = corridor([7, 0, 'P']);
    assert.equal(threatMap(grid, CORRIDOR_RUNNER, 'static')[1][4], 3, 'paper reaches e2 in 3');

    // The rock stands on e2 after its third move, and a predator that needs
    // three moves is there in time. One square further away and it is not.
    assert.equal(safeRun(grid, CORRIDOR_RUNNER, 0, runOptions()), null);
  });

  it('loses a tempo when the other side moves first', () => {
    const grid = corridor([8, 0, 'P']);

    assert.ok(safeRun(grid, CORRIDOR_RUNNER, 0, runOptions({ walkerToMove: true })));
    assert.equal(
      safeRun(grid, CORRIDOR_RUNNER, 0, runOptions({ walkerToMove: false })),
      null,
      'the extra enemy move is worth exactly the square that was spare',
    );
  });

  it('ignores predators entirely when safety is off', () => {
    const run = safeRun(corridor([7, 0, 'P']), CORRIDOR_RUNNER, 0, runOptions({ safety: 'off' }));

    assert.ok(run);
    assert.equal(run.moves, 4);
  });

  it('does not ask the winning square to be survivable', () => {
    // e2 with the goal one step away, and a blue paper beside the goal square.
    const grid = board(
      [4, 1, 'r'],
      [3, 0, 'P'], [5, 0, 'r'], [3, 1, 'r'], [5, 1, 'r'],
    );
    const walker = redRock(4, 1);

    const winning = safeRun(grid, walker, 0, runOptions({ goalEndsGame: true }));
    assert.ok(winning);
    assert.equal(winning.moves, 1, 'landing on the goal ends the game before the reply');

    const cautious = safeRun(grid, walker, 0, runOptions({ goalEndsGame: false }));
    assert.ok(cautious);
    assert.ok(cautious.moves > 1, 'made to survive there, it has to go the long way round');
  });

  it('asks more of a run than the per-step rule does', () => {
    // `wholeRun` wants every square of the path to be out of reach for the
    // whole run, so it can never find a shorter route than `perStep`.
    const grids = [
      corridor([8, 0, 'P']),
      corridor([7, 0, 'P']),
      corridor([2, 0, 'P'], [6, 6, 'P']),
      board([4, 4, 'r'], [0, 0, 'P']),
      board([4, 6, 'r'], [4, 2, 'P'], [1, 1, 'P']),
    ];

    for (const grid of grids) {
      const walker = walkersOn(grid).find(
        (candidate) => candidate.owner === 'Red' && candidate.piece === 'Rock',
      );
      assert.ok(walker);
      const perStep = safeRun(grid, walker, 0, runOptions());
      const wholeRun = safeRun(grid, walker, 0, runOptions({ safety: 'wholeRun' }));
      if (wholeRun) {
        assert.ok(perStep, 'anything the stricter rule allows the looser one allows too');
        assert.ok(wholeRun.moves >= perStep.moves);
      }
    }
  });
});

describe('analyzeReach', () => {
  it('has nothing to say in a mode without a goal row', () => {
    assert.equal(goalRowFor('V5', 'Red'), null);
    assert.equal(supportsReachRace('V5'), false);
    assert.equal(
      analyzeReach({ ...position(V3.startingPosition.rows), mode: V5 }, reachOptions()),
      null,
    );
  });

  it('reads the open distance straight off the rank', () => {
    const analysis = analyzeReach(position(V3.startingPosition.rows), reachOptions());
    assert.ok(analysis);

    for (const reading of analysis.readings) {
      const goal = reading.walker.owner === 'Red' ? 0 : BOARD_SIZE - 1;
      assert.equal(
        reading.openDistance,
        Math.abs(reading.walker.from.y - goal),
        'a king covers one rank per move',
      );
    }
  });

  it('names the square that decides a race', () => {
    const analysis = analyzeReach(
      { grid: corridor([7, 0, 'P']), currentTurn: 'Red', mode: V3, moveNumber: 0 },
      reachOptions(),
    );
    assert.ok(analysis);

    const runner = analysis.readings.find(
      (reading) => reading.walker.from.x === 4 && reading.walker.from.y === 4,
    );
    assert.ok(runner);
    assert.equal(runner.safeDistance, null, 'the corridor is the only route and it is cut');
    assert.deepEqual(runner.cutOff?.at, { x: 4, y: 1 });
    assert.equal(runner.cutOff?.arrivalStep, 3);
    assert.equal(runner.cutOff?.threat, 3);
  });

  it('calls a piece with no predators left immortal, and lets it walk', () => {
    const grid = board([4, 4, 'r'], [0, 8, 'S'], [8, 8, 'R']);
    const analysis = analyzeReach(
      { grid, currentTurn: 'Red', mode: V3, moveNumber: 0 },
      reachOptions(),
    );
    assert.ok(analysis);

    const rock = analysis.readings.find((reading) => reading.walker.piece === 'Rock' && reading.walker.owner === 'Red');
    assert.ok(rock);
    assert.equal(rock.immortal, true);
    assert.equal(rock.predatorCount, 0);
    assert.equal(rock.attackedIn, UNREACHABLE);
    assert.equal(rock.safeDistance, rock.blockedDistance, 'nothing can interfere with it');
    assert.equal(rock.safeDistance, 4);
  });

  it('gives the race to whoever arrives first, counting the tempo', () => {
    // Red is four moves from row 0 and Blue four from row 8. Neither side owns
    // a piece of the kind that captures the other's runner, so both runs are
    // clear and only the tempo separates them.
    const grid = board([4, 4, 'r'], [2, 4, 'R']);

    const redToMove = analyzeReach(
      { grid, currentTurn: 'Red', mode: V3, moveNumber: 0 },
      reachOptions({ toMove: 'Red' }),
    );
    const blueToMove = analyzeReach(
      { grid, currentTurn: 'Blue', mode: V3, moveNumber: 0 },
      reachOptions({ toMove: 'Blue' }),
    );

    assert.ok(redToMove && blueToMove);
    assert.equal(redToMove.verdict.red?.safeDistance, 4);
    assert.equal(redToMove.verdict.blue?.safeDistance, 4);
    assert.equal(redToMove.verdict.winner, 'Red', 'a dead heat goes to the side to move');
    assert.equal(redToMove.verdict.margin, 0);
    assert.equal(blueToMove.verdict.winner, 'Blue', 'and the same position flips with the turn');
  });

  it('reads a mirrored board the same way', () => {
    // Files carry no meaning of their own — the goal is a whole rank — which is
    // the fact `StartingPosition.MirrorsFiles` and the engine's book both rest
    // on, so a verdict that changed under a mirror would be a bug.
    const rows = [
      '..P......',
      '.........',
      '....s....',
      '.........',
      '...r.....',
      '.........',
      '.......S.',
      '.........',
      '......p..',
    ];
    const mirrored = rows.map((row) => [...row].reverse().join(''));

    for (const toMove of ['Red', 'Blue'] as const) {
      const straight = analyzeReach(position(rows, toMove), reachOptions({ toMove }));
      const flipped = analyzeReach(position(mirrored, toMove), reachOptions({ toMove }));
      assert.ok(straight && flipped);
      assert.equal(flipped.verdict.winner, straight.verdict.winner, `winner, ${toMove} to move`);
      assert.equal(flipped.verdict.margin, straight.verdict.margin, `margin, ${toMove} to move`);
      assert.equal(flipped.verdict.red?.safeDistance, straight.verdict.red?.safeDistance);
      assert.equal(flipped.verdict.blue?.safeDistance, straight.verdict.blue?.safeDistance);
    }
  });

  it('reads every piece on the board, in board order', () => {
    const analysis = analyzeReach(position(V3.startingPosition.rows), reachOptions());
    assert.ok(analysis);
    assert.equal(analysis.readings.length, 18);

    const order = analysis.readings.map(({ walker }) => walker.from.y * BOARD_SIZE + walker.from.x);
    assert.deepEqual(order, [...order].sort((left, right) => left - right));
  });

  it('agrees with itself across obstacle models', () => {
    // Opening every route can only ever shorten one.
    const rows = V3.startingPosition.rows;
    const models: ObstacleModel[] = ['static', 'friendlyVacates', 'open'];
    const distances = models.map((obstacles) => {
      const analysis = analyzeReach(position(rows), reachOptions({ obstacles }));
      assert.ok(analysis);
      return analysis.readings.map((reading) => reading.blockedDistance);
    });

    for (let index = 0; index < distances[0].length; index += 1) {
      assert.ok(distances[1][index] <= distances[0][index], 'friends stepping aside cannot cost');
      assert.ok(distances[2][index] <= distances[1][index], 'nor can ignoring everyone');
    }
  });
});
