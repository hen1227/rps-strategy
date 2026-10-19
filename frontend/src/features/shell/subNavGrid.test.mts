// When the phone's page strip turns into a grid, and what shape the grid is.
//
// The strip is measured on a device, so the only place its arithmetic can be
// pinned is here. The widths below are the iPhone 17 Pro's Compete strip as it
// measured: 370 points inside the padding, chips of 96, 107, 98 and 100.

import assert from 'node:assert/strict';
import test from 'node:test';

import { gridFor } from './subNavGrid.ts';

const GAP = 6;

test('a strip that fits on one line stays a line', () => {
  assert.equal(gridFor([80, 90, 60], 370, GAP), null);
});

test('nothing changes until every chip has been measured', () => {
  assert.equal(gridFor([96, 107, undefined, 100], 370, GAP), null);
  assert.equal(gridFor([96, 107, 98, 100], 0, GAP), null);
});

test('four chips that would leave one alone are two rows of two', () => {
  assert.deepEqual(gridFor([96, 107, 98, 100], 370, GAP), { columns: 2, cell: 182 });
});

test('six chips that fit three to a row are two rows of three', () => {
  assert.deepEqual(gridFor([72, 92, 80, 66, 64, 58], 370, GAP), { columns: 3, cell: 119 });
});

test('a label too long for any shared row gets a row of its own', () => {
  assert.deepEqual(gridFor([200, 210], 370, GAP), { columns: 1, cell: 370 });
});
