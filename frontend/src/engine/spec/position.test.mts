import assert from 'node:assert/strict';
import test from 'node:test';

import { INFILTRATION_SPEC, STANDARD_PIECES, TOTAL_WAR_SPEC } from './builtin';
import {
  describePosition,
  fitRows,
  isStandardPosition,
  positionFits,
  refitRows,
  standardRows,
} from './position';
import { validateSpec } from './validate';
import type { RuleSpec } from './types';

/** Swapping case swaps sides, which is the whole of the layout convention. */
const otherSide = (row: string) =>
  Array.from(row)
    .map((letter) => (letter === letter.toUpperCase() ? letter.toLowerCase() : letter.toUpperCase()))
    .join('');

// The default opening has one job that matters more than the rest: it has to
// agree with the modes it generalises. A 9×9 board with Rock, Paper and Scissors
// on it is not a case this module gets to have an opinion about — the answer has
// been shipped for as long as the project has existed, and every archived game
// starts from it.

test('the default opening for the standard board is the shipped one', () => {
  assert.deepEqual(standardRows(TOTAL_WAR_SPEC), TOTAL_WAR_SPEC.startingPosition.rows);
  assert.deepEqual(standardRows(INFILTRATION_SPEC), INFILTRATION_SPEC.startingPosition.rows);
  assert.equal(isStandardPosition(TOTAL_WAR_SPEC), true);
  assert.equal(describePosition(TOTAL_WAR_SPEC), 'the standard opening');
});

test('the default opening is symmetric, centred and playable on any board', () => {
  for (const width of [3, 5, 8, 9, 11, 16]) {
    for (const height of [3, 4, 7, 9, 12]) {
      for (const kinds of [1, 2, 3, 5]) {
        const spec: RuleSpec = {
          ...TOTAL_WAR_SPEC,
          board: { width, height },
          pieces: Array.from({ length: kinds }, (_unused, index) => ({
            id: `K${index}`,
            name: `Kind ${index}`,
            symbol: String.fromCharCode(65 + index),
          })),
          beats: [],
          capture: { mode: 'never' },
        };
        const rows = standardRows(spec);
        const where = `${width}x${height} with ${kinds} kinds`;

        assert.equal(rows.length, height, `height, ${where}`);
        for (const row of rows) assert.equal(row.length, width, `width, ${where}`);

        // Mirrored: rank y for Blue is rank h-1-y for Red, in the other case.
        for (let y = 0; y < height; y += 1) {
          assert.equal(rows[y], otherSide(rows[height - 1 - y] ?? ''), `mirror, ${where}`);
        }

        const letters = rows.join('');
        assert.ok(/[A-Z]/.test(letters), `Blue has pieces, ${where}`);
        assert.ok(/[a-z]/.test(letters), `Red has pieces, ${where}`);

        // Centred, so neither flank starts a move ahead of the other.
        for (const row of rows) {
          assert.equal(
            row.length - row.replace(/^\.+/, '').length,
            row.length - row.replace(/\.+$/, '').length,
            `centred, ${where}: ${row}`,
          );
        }

        assert.deepEqual(
          validateSpec({ ...spec, startingPosition: { rows } }).errors,
          [],
          `validates, ${where}`,
        );
      }
    }
  }
});

test('every declared kind reaches the opening board, even on a shallow one', () => {
  // Four kinds and only room for two ranks a side: a kind left off the board is
  // a kind no playtest can exercise, so the ranks get crowded instead.
  const spec: RuleSpec = {
    ...TOTAL_WAR_SPEC,
    board: { width: 9, height: 5 },
    pieces: [
      { id: 'A', name: 'A', symbol: 'A' },
      { id: 'B', name: 'B', symbol: 'B' },
      { id: 'C', name: 'C', symbol: 'C' },
      { id: 'D', name: 'D', symbol: 'D' },
    ],
    beats: [],
    capture: { mode: 'never' },
  };
  const letters = new Set(standardRows(spec).join('').replace(/[^A-Z]/g, ''));
  assert.deepEqual([...letters].sort(), ['A', 'B', 'C', 'D']);
});

/* ------------------------------------------------------------ carrying one -- */

const specOn = (width: number, height: number, pieces = STANDARD_PIECES): RuleSpec => ({
  ...TOTAL_WAR_SPEC,
  board: { width, height },
  pieces,
});

test('a widened board keeps its layout, centred', () => {
  const wider = specOn(11, 9);
  assert.deepEqual(fitRows(TOTAL_WAR_SPEC.startingPosition.rows, wider), [
    '....SSS....',
    '....PPP....',
    '....RRR....',
    '...........',
    '...........',
    '...........',
    '....rrr....',
    '....ppp....',
    '....sss....',
  ]);
});

test('a taller board keeps each side against its own home rank', () => {
  const taller = specOn(9, 11);
  assert.deepEqual(fitRows(TOTAL_WAR_SPEC.startingPosition.rows, taller), [
    '...SSS...',
    '...PPP...',
    '...RRR...',
    '.........',
    '.........',
    '.........',
    '.........',
    '.........',
    '...rrr...',
    '...ppp...',
    '...sss...',
  ]);
});

test('a layout that already fits comes back unchanged', () => {
  assert.deepEqual(
    fitRows(TOTAL_WAR_SPEC.startingPosition.rows, TOTAL_WAR_SPEC),
    TOTAL_WAR_SPEC.startingPosition.rows,
  );
});

test('a letter whose kind has gone becomes an empty square', () => {
  const withoutPaper = specOn(9, 9, [
    { id: 'Rock', name: 'Rock', symbol: 'R', art: 'rock' },
    { id: 'Scissors', name: 'Scissors', symbol: 'S', art: 'scissors' },
  ]);
  const rows = fitRows(TOTAL_WAR_SPEC.startingPosition.rows, withoutPaper);
  assert.deepEqual(rows?.[1], '.........');
  assert.deepEqual(rows?.[0], '...SSS...');
});

test('nothing worth carrying falls back to the default', () => {
  // Every kind renamed: not one letter survives, so carrying it would leave an
  // empty board rather than a game.
  const renamed = specOn(9, 9, [
    { id: 'Boulder', name: 'Boulder', symbol: 'B', art: 'rock' },
    { id: 'Scroll', name: 'Scroll', symbol: 'C', art: 'paper' },
    { id: 'Shears', name: 'Shears', symbol: 'H', art: 'scissors' },
  ]);
  assert.equal(fitRows(TOTAL_WAR_SPEC.startingPosition.rows, renamed), null);
  assert.deepEqual(refitRows(TOTAL_WAR_SPEC.startingPosition.rows, renamed), standardRows(renamed));
  assert.deepEqual(refitRows(undefined, renamed), standardRows(renamed));
});

test('a change that would leave one side with no pieces falls back too', () => {
  // Only Blue's half survives the crop, and a Red with no pieces has no move.
  const rows = ['...SSS...', '...PPP...', '...RRR...', '.........', '.........'];
  assert.equal(fitRows(rows, specOn(9, 5)), null);
});

/* ------------------------------------------------------------- recognising -- */

test('positionFits agrees with the validator about the layout', () => {
  assert.equal(positionFits(TOTAL_WAR_SPEC), true);

  const widened = { ...TOTAL_WAR_SPEC, board: { width: 11, height: 9 } };
  assert.equal(positionFits(widened), false);
  assert.ok(
    validateSpec(widened).errors.some((issue) => issue.path === 'startingPosition.rows'),
    'the validator objects to the same layout',
  );

  const repaired = { ...widened, startingPosition: { rows: refitRows(widened.startingPosition.rows, widened) } };
  assert.equal(positionFits(repaired), true);
  assert.deepEqual(validateSpec(repaired).errors, []);
});

test('a hand-made opening is not mistaken for the default', () => {
  const custom: RuleSpec = {
    ...TOTAL_WAR_SPEC,
    startingPosition: { rows: ['RRRRRRRRR', ...Array(7).fill('.........'), 'rrrrrrrrr'] },
  };
  assert.equal(isStandardPosition(custom), false);
  assert.equal(describePosition(custom), 'a custom opening');
});

