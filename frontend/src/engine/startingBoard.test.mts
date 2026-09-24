// A board somebody set up, rather than a mode's opening.
//
// The claim under test is the one the position editor rests on: pieces alone do
// not describe a position. A side to move and, in a mode with territory, who
// owns each tile are part of it, they are what the three-field FEN carries, and
// they have to survive being written down and read back.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  createAnalysisGame,
  createAnalysisGameOn,
  gridFromRows,
  ownerRowsFrom,
  sideToMove,
  startingPositionFromGrid,
} from '@/engine/analysisGame';
import { decodePosition, encodePosition } from '@/engine/pgn';
import { FIRST_TO_MOVE, type ModeDefinition } from '@/types/game';

const ROWS = ['RPS......', '.........', '.........', '.........', '.........', '.........', '.........', '.........', 'rps......'];

const totalWar: ModeDefinition = {
  id: 'V5',
  shortCode: 'TW',
  name: 'Total War',
  description: '',
  objective: '',
  displayOrder: 1,
  playable: true,
  features: ['territory'],
  startingPosition: { rows: ROWS },
};

test('ownership follows the pieces when nobody has said otherwise', () => {
  const grid = gridFromRows(ROWS);
  assert.equal(grid[0]?.[0]?.ownerColor, 'Blue', 'a1 holds a Blue rock');
  assert.equal(grid[8]?.[0]?.ownerColor, 'Red', 'a9 holds a Red rock');
  assert.equal(grid[4]?.[4]?.ownerColor, 'Neutral', 'the middle is empty and unowned');
});

test('owner rows replace ownership rather than adding to it', () => {
  // Every tile blank but a2, which Red holds with no piece on it — and a1,
  // which Blue has a rock on and does *not* own. Total War can reach both, so
  // an editor has to be able to state both.
  const owners = ['.........', 'r........', ...Array.from({ length: 7 }, () => '.........')];
  const grid = gridFromRows(ROWS, undefined, owners);
  assert.equal(grid[0]?.[0]?.occupantOwner, 'Blue', 'the rock is still Blue');
  assert.equal(grid[0]?.[0]?.ownerColor, 'Neutral', 'but the ground under it is nobody');
  assert.equal(grid[1]?.[0]?.ownerColor, 'Red', 'and Red holds ground it has no piece on');
});

test('territory read back out is the territory that went in', () => {
  const owners = ['bbb......', '.........', '..rr.....', ...Array.from({ length: 6 }, () => '.........')];
  assert.deepEqual(ownerRowsFrom(gridFromRows(ROWS, undefined, owners)), owners);
});

test('a board with no side to move is played from the opener', () => {
  assert.equal(sideToMove(undefined), FIRST_TO_MOVE);
  assert.equal(sideToMove('Neutral'), FIRST_TO_MOVE);
  assert.equal(sideToMove('Red'), 'Red');
  assert.equal(sideToMove('Blue'), 'Blue');
});

test('no board given is the mode the game is for, opening as it always does', () => {
  const opening = createAnalysisGame(totalWar);
  const implied = createAnalysisGameOn(totalWar);
  assert.deepEqual(startingPositionFromGrid(implied.grid), startingPositionFromGrid(opening.grid));
  assert.equal(implied.currentTurn, FIRST_TO_MOVE);
});

test('a board given is played from, with its own side to move', () => {
  const owners = ['.........', 'r........', ...Array.from({ length: 7 }, () => '.........')];
  const game = createAnalysisGameOn(totalWar, {
    currentTurn: 'Red',
    grid: gridFromRows(ROWS, undefined, owners),
  });
  assert.equal(game.currentTurn, 'Red', 'Red to play, though Blue opens an ordinary game');
  assert.equal(game.grid[1]?.[0]?.ownerColor, 'Red');
  assert.equal(game.status, 'InProgress');
});

test('a set-up board is exactly what a FEN carries, and survives the round trip', () => {
  // The whole reason a position travels as a FEN rather than as rows: this
  // board's side to move is not the opener and its territory does not follow
  // its pieces, and a layout string can state neither.
  const owners = ['.........', 'r........', '..bb.....', ...Array.from({ length: 6 }, () => '.........')];
  const start = { currentTurn: 'Red' as const, grid: gridFromRows(ROWS, undefined, owners) };
  const fen = encodePosition(start.grid, start.currentTurn);

  const read = decodePosition(fen);
  assert.equal(read.currentTurn, 'Red');
  assert.deepEqual(startingPositionFromGrid(read.grid), startingPositionFromGrid(start.grid));
  assert.deepEqual(ownerRowsFrom(read.grid), owners);
  assert.equal(encodePosition(read.grid, read.currentTurn), fen, 'and writes back the same text');
});
