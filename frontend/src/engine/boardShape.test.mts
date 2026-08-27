// A mode may be any rectangle. These are the places that used to know the board
// was nine by nine, checked on a board that is neither nine nor square.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  applyAnalysisMove,
  createAnalysisGame,
  gridFromRows,
  moveLabel,
  squareLabel,
  startingPositionFromGrid,
  stepTargets,
  validMovesFor,
} from '@/engine/analysisGame';
import { decodePosition, encodePosition, formatSquare, parseSquare } from '@/engine/pgn';
import {
  boardHeight,
  boardWidth,
  isBoardRows,
  isOnBoard,
  MAX_BOARD_SIDE,
  type ModeDefinition,
} from '@/types/game';

/** Five files, seven ranks: Blue's home rank is 1 and Red's is 7. */
const RECTANGLE_ROWS = ['RPS..', '.....', '.....', '.....', '.....', '.....', 'rps..'];

const rectangleMode = (id = 'V5'): ModeDefinition => ({
  id,
  shortCode: 'RECT',
  name: 'Rectangle',
  description: '',
  objective: '',
  displayOrder: 98,
  playable: true,
  features: [],
  startingPosition: { rows: RECTANGLE_ROWS },
});

test('a grid takes its shape from the rows it was built from', () => {
  const grid = gridFromRows(RECTANGLE_ROWS);
  assert.equal(boardWidth(grid), 5);
  assert.equal(boardHeight(grid), 7);
  assert.equal(grid[0]?.[0]?.occupant, 'Rock');
  assert.equal(grid[0]?.[0]?.occupantOwner, 'Blue');
  assert.equal(grid[6]?.[0]?.occupantOwner, 'Red');
  assert.deepEqual(startingPositionFromGrid(grid).rows, RECTANGLE_ROWS);
});

test('a coordinate is on the board the grid describes, not on a nine by nine one', () => {
  const grid = gridFromRows(RECTANGLE_ROWS);
  assert.ok(isOnBoard(grid, { x: 4, y: 6 }));
  assert.ok(!isOnBoard(grid, { x: 5, y: 6 }), 'f7 is off a five-wide board');
  assert.ok(!isOnBoard(grid, { x: 4, y: 7 }), 'e8 is off a seven-tall board');
  assert.ok(!isOnBoard(grid, { x: -1, y: 0 }));
});

test('movement stops at the real edges', () => {
  const grid = gridFromRows(RECTANGLE_ROWS);
  // Red's corner rock on a7: three neighbours, one holding its own paper.
  const targets = stepTargets(grid, { x: 0, y: 6 }, 'Red', 'Rock');
  assert.ok(targets.every((to) => isOnBoard(grid, to)));
  assert.deepEqual(
    targets.map(({ x, y }) => `${x},${y}`).sort(),
    ['0,5', '1,5'],
  );
});

test('a game plays on a five by seven board', () => {
  const game = createAnalysisGame(rectangleMode());
  const moves = validMovesFor(game, { x: 0, y: 6 });
  assert.equal(moves.length, 2, 'the corner rock has two moves');
  const played = applyAnalysisMove(game, { x: 0, y: 6 }, { x: 0, y: 5 });
  assert.ok(played, 'a legal move on a rectangle is legal');
  assert.equal(played.game.currentTurn, 'Blue');
  assert.equal(boardWidth(played.game.grid), 5);
});

test("Infiltration's goal rank is the board's last, not rank nine", () => {
  // Red reaching rank 1 wins; Blue reaching rank 7 — the last rank of *this*
  // board — wins. On a nine-by-nine assumption Blue's win would never fire.
  const game = createAnalysisGame(rectangleMode('V3'), {
    rows: ['.....', '.....', '.....', '.....', '.....', '....S', 'r....'],
  });
  const blueToMove = applyAnalysisMove(game, { x: 0, y: 6 }, { x: 0, y: 5 });
  assert.ok(blueToMove);
  const infiltrated = applyAnalysisMove(blueToMove.game, { x: 4, y: 5 }, { x: 4, y: 6 });
  assert.ok(infiltrated);
  assert.equal(infiltrated.game.status, 'Finished');
  assert.equal(infiltrated.game.winner, 'Blue');
  assert.equal(infiltrated.game.endReason, 'infiltration');
});

test('a position round-trips through the archive notation on any shape', () => {
  const grid = gridFromRows(['RPS.....SPR', '...........', '...........', 'rps.....spr']);
  const encoded = encodePosition(grid, 'Red');
  const decoded = decodePosition(encoded);
  assert.equal(boardWidth(decoded.grid), 11);
  assert.equal(boardHeight(decoded.grid), 4);
  assert.equal(decoded.currentTurn, 'Red');
  assert.deepEqual(
    startingPositionFromGrid(decoded.grid).rows,
    startingPositionFromGrid(grid).rows,
  );
  // A run of empties wider than nine has to survive, which is what multi-digit
  // gaps are for.
  assert.equal(boardWidth(decodePosition('11/11/11/11 r').grid), 11);
  assert.throws(() => decodePosition('11/11/11/10 r'), /rank 4/);
});

test('squares are named past file i and rank 9', () => {
  assert.equal(squareLabel({ x: 9, y: 9 }), 'j10');
  assert.equal(formatSquare({ x: 25, y: 25 }), 'z26');
  assert.equal(formatSquare({ x: MAX_BOARD_SIDE, y: 0 }), '??');
  assert.deepEqual(parseSquare('j10'), { x: 9, y: 9 });
  assert.deepEqual(parseSquare('z26'), { x: 25, y: 25 });
  assert.equal(moveLabel({ from: { x: 9, y: 9 }, to: { x: 10, y: 10 } }), 'j10–k11');
  for (const notASquare of ['aa1', 'z27', 'a0', 'a', '1a']) {
    assert.throws(() => parseSquare(notASquare), /is not a square/, notASquare);
  }
});

test('a layout is a rectangle within the sizes this project can play', () => {
  assert.ok(isBoardRows(RECTANGLE_ROWS));
  assert.ok(isBoardRows(['rps', '...', 'RPS']));
  assert.ok(!isBoardRows(['rp', '..', 'RP']), 'two files is not a board');
  assert.ok(!isBoardRows(['rps..', '....', 'RPS..']), 'ranks must agree in width');
  assert.ok(!isBoardRows(Array.from({ length: 27 }, () => '...')), '27 ranks is too many');
  assert.ok(!isBoardRows(undefined));
});
