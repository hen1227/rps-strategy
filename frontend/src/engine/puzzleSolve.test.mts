import assert from 'node:assert/strict';
import test from 'node:test';

import { gridFromRows } from './analysisGame.ts';
import {
  judgeSolveMove,
  moveOnto,
  oneOf,
  reachableBy,
  solveGame,
  type SolvePosition,
} from './puzzleSolve.ts';
import { testMode } from '@/testing/modes';

// Rank 1 first, as every layout here is written: row 0 is the bottom of the
// board as Blue sees it.
const rows = (...ranks: string[]) => [...ranks, ...Array(9 - ranks.length).fill('.........')];

test('a square is in reach of a piece that may step onto it', () => {
  // A red scissors on b2 reaches every neighbour that is empty or holds paper.
  const grid = gridFromRows(rows('.........', '.s.......', 'P.R......'));
  assert.equal(reachableBy(grid, { x: 0, y: 0 }, 'Red'), true, 'an empty neighbour');
  assert.equal(reachableBy(grid, { x: 0, y: 2 }, 'Red'), true, 'a paper it takes');
  assert.equal(reachableBy(grid, { x: 2, y: 2 }, 'Red'), false, 'a rock that takes it');
  assert.equal(reachableBy(grid, { x: 3, y: 3 }, 'Red'), false, 'two squares away');
});

test('reach is asked of one side only', () => {
  const grid = gridFromRows(rows('.........', '.s.......'));
  assert.equal(reachableBy(grid, { x: 0, y: 0 }, 'Blue'), false);
});

test('a piece never reaches a square its own side stands on', () => {
  const grid = gridFromRows(rows('p........', '.s.......'));
  assert.equal(reachableBy(grid, { x: 0, y: 0 }, 'Red'), false);
});

test('oneOf accepts the moves it names and nothing else', () => {
  const solves = oneOf({ from: { x: 1, y: 1 }, to: { x: 2, y: 2 } });
  const position: SolvePosition = {
    board: { grid: gridFromRows(rows('.........', '.R.......', '..s......')), currentTurn: 'Blue' },
    solves,
  };
  const game = solveGame(testMode('V6'), position);
  assert.equal(judgeSolveMove(position, game, { x: 1, y: 1 }, { x: 2, y: 2 })?.verdict, 'solved');
  assert.equal(judgeSolveMove(position, game, { x: 1, y: 1 }, { x: 1, y: 2 })?.verdict, 'wrong');
  // Off the rock's reach entirely: not a verdict, because not a move.
  assert.equal(judgeSolveMove(position, game, { x: 1, y: 1 }, { x: 3, y: 3 }), null);
});

test('a judged move carries the board it led to', () => {
  const position: SolvePosition = {
    board: { grid: gridFromRows(rows('.........', '.R.......', '..s......')), currentTurn: 'Blue' },
    solves: () => true,
  };
  const game = solveGame(testMode('V6'), position);
  const judged = judgeSolveMove(position, game, { x: 1, y: 1 }, { x: 2, y: 2 });
  assert.equal(judged?.applied.captured, true);
  assert.equal(judged?.applied.game.grid[2]?.[2]?.occupant, 'Rock');
  // The position itself is untouched, so a wrong answer can be put back.
  assert.equal(game.grid[2]?.[2]?.occupant, 'Scissors');
});

test('moveOnto finds a move of the side to move onto a square, or nothing', () => {
  // Red to move: its scissors on b2 may take the paper on a1, and nothing of
  // Red's reaches d4.
  const position: SolvePosition = {
    board: { grid: gridFromRows(rows('P........', '.s.......')), currentTurn: 'Red' },
    solves: () => false,
  };
  const game = solveGame(testMode('V6'), position);
  assert.deepEqual(moveOnto(game, { x: 0, y: 0 }), { from: { x: 1, y: 1 }, to: { x: 0, y: 0 } });
  assert.equal(moveOnto(game, { x: 3, y: 3 }), null);
});
