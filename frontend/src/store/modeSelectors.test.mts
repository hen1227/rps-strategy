import assert from 'node:assert/strict';
import test from 'node:test';

import { featuredModeOf, playableModesOf, variantModesOf } from './modeSelectors.ts';
import { testMode } from '../testing/modes.ts';

// The catalogue as the server sends it today: Intransitive ranked first.
const CATALOGUE = [
  testMode('V6', { displayOrder: 1 }),
  testMode('V5', { displayOrder: 2 }),
  testMode('V3', { displayOrder: 3 }),
];

test('the main game is the playable mode the catalogue ranks first', () => {
  assert.equal(featuredModeOf(CATALOGUE)?.id, 'V6');
  assert.deepEqual(
    variantModesOf(CATALOGUE).map((mode) => mode.id),
    ['V5', 'V3'],
  );
});

test('the ranking is read from displayOrder, not from where a mode sits in the list', () => {
  const shuffled = [CATALOGUE[2]!, CATALOGUE[0]!, CATALOGUE[1]!];
  assert.equal(featuredModeOf(shuffled)?.id, 'V6');
  // The variants keep the list's own order, which is the order they are drawn in.
  assert.deepEqual(
    variantModesOf(shuffled).map((mode) => mode.id),
    ['V3', 'V5'],
  );
});

test('a retired mode is never featured, however high it ranks', () => {
  const retired = [testMode('V6', { displayOrder: 1, playable: false }), ...CATALOGUE.slice(1)];
  assert.equal(featuredModeOf(retired)?.id, 'V5');
  assert.deepEqual(
    playableModesOf(retired).map((mode) => mode.id),
    ['V5', 'V3'],
  );
  assert.deepEqual(
    variantModesOf(retired).map((mode) => mode.id),
    ['V3'],
  );
});

test('a mode with no order ranks after every mode that has one', () => {
  const unranked = [
    testMode('LAB', { displayOrder: undefined as unknown as number }),
    testMode('V5', { displayOrder: 2 }),
  ];
  assert.equal(featuredModeOf(unranked)?.id, 'V5');
});

test('ties keep the catalogue order, and nothing playable features nothing', () => {
  const tied = [testMode('V5', { displayOrder: 1 }), testMode('V3', { displayOrder: 1 })];
  assert.equal(featuredModeOf(tied)?.id, 'V5');
  assert.equal(featuredModeOf([]), null);
  assert.deepEqual(variantModesOf([]), []);
});
