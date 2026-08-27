import assert from 'node:assert/strict';
import test from 'node:test';

import { startingPositionFromGrid } from './analysisGame';
import {
  formatBookMove,
  gameAfterWalk,
  lastStepOfWalk,
  openingLineOf,
  parseBookMove,
  playBookMove,
  walkOpeningLine,
} from './openingLine';
import type { ModeDefinition } from '../types/game';

const infiltration: ModeDefinition = {
  id: 'V3',
  shortCode: 'V3',
  name: 'Infiltration',
  description: 'Reach their boundary.',
  objective: "Move any piece onto the opponent's home boundary.",
  displayOrder: 3,
  playable: true,
  features: [],
  startingPosition: {
    rows: [
      '...SSS...',
      '...PPP...',
      '...RRR...',
      '.........',
      '.........',
      '.........',
      '...rrr...',
      '...ppp...',
      '...sss...',
    ],
  },
};

test('a book move is read without the piece letter the engine leaves out', () => {
  assert.deepEqual(parseBookMove('d9-c8'), { from: { x: 3, y: 8 }, to: { x: 2, y: 7 } });
});

test('the PGN forms of the same move are accepted too', () => {
  assert.deepEqual(parseBookMove('Sd9-c8'), parseBookMove('d9-c8'));
  assert.deepEqual(parseBookMove('Sd9xRc8'), parseBookMove('d9-c8'));
});

test('anything that is not a move reads as no move', () => {
  for (const token of ['', 'd9', 'd9-c8-b7', 'j9-c8', 'd0-c8', '(none)', null]) {
    assert.equal(parseBookMove(token), null, `${token} should not parse`);
  }
});

test('a line replays into the position it names', () => {
  const walk = walkOpeningLine(infiltration, ['d9-c8', 'd2-c3']);
  assert.ok(walk);
  assert.equal(walk.truncated, false);
  assert.equal(walk.steps.length, 2);
  assert.equal(walk.steps[0]?.mover, 'Red');
  assert.equal(walk.steps[1]?.mover, 'Blue');

  const rows = startingPositionFromGrid(gameAfterWalk(walk)?.grid);
  assert.deepEqual(rows.rows, [
    '...SSS...',
    '....PP...',
    '..PRRR...',
    '.........',
    '.........',
    '.........',
    '...rrr...',
    '..sppp...',
    '....ss...',
  ]);
});

test('the empty line is the opening position, with no move to draw', () => {
  const walk = walkOpeningLine(infiltration, []);
  assert.ok(walk);
  assert.equal(lastStepOfWalk(walk), null);
  assert.equal(gameAfterWalk(walk), walk.start);
  assert.equal(walk.start.currentTurn, 'Red');
});

test('a line that stops being legal keeps the boards it did reach', () => {
  const walk = walkOpeningLine(infiltration, ['d9-c8', 'a1-a2']);
  assert.ok(walk);
  assert.equal(walk.truncated, true);
  assert.equal(walk.steps.length, 1);
  assert.equal(lastStepOfWalk(walk)?.notation, 'd9-c8');
});

test('a mode with no starting position has no board to replay onto', () => {
  assert.equal(walkOpeningLine(null, ['d9-c8']), null);
  assert.equal(playBookMove(null, 'd9-c8'), null);
});

test('a capture is reported so the diagram can ring the square', () => {
  // Red walks a rock up the b file and Blue's paper takes it on b4.
  const walk = walkOpeningLine(infiltration, [
    'd7-c6', 'd1-c1', 'c6-b5', 'd2-c3', 'b5-b4', 'c3-b4',
  ]);
  assert.ok(walk);
  assert.equal(walk.truncated, false);
  assert.equal(lastStepOfWalk(walk)?.captured, true);
  assert.equal(lastStepOfWalk(walk)?.mover, 'Blue');
  assert.deepEqual(
    walk.steps.slice(0, -1).map((step) => step.captured),
    [false, false, false, false, false],
  );
});

test('a record of moves becomes the line the book keys names by', () => {
  const moves = [
    { from: { x: 3, y: 8 }, to: { x: 2, y: 7 } },
    { from: { x: 3, y: 1 }, to: { x: 2, y: 2 } },
  ];
  assert.deepEqual(openingLineOf(moves), ['d9-c8', 'd2-c3']);
  assert.deepEqual(openingLineOf(moves, 1), ['d9-c8']);
  assert.deepEqual(openingLineOf(null), []);
});

test('a book move written out is a book move read back', () => {
  for (const notation of ['d9-c8', 'a1-i9', 'e5-e6']) {
    const move = parseBookMove(notation);
    assert.equal(move && formatBookMove(move), notation);
  }
});
