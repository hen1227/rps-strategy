import assert from 'node:assert/strict';
import test from 'node:test';

import {
  nodeAtLine,
  openingKind,
  openingNameForLine,
  validateOpeningBookDocument,
} from './openingBook';

import type { OpeningName, OpeningNode } from './openingBook';

const names: OpeningName[] = [
  { modeId: 'V3', line: ['d8-c7'], name: 'Skipping Stone Opening' },
  { modeId: 'V3', line: ['d8-c7', 'd2-c3', 'c7-d6'], name: 'Skipping Stone: Crane Lift' },
];

test('exact names override inherited opening labels', () => {
  assert.deepEqual(openingNameForLine(names, ['d8-c7']), {
    exact: true,
    inherited: false,
    label: 'Skipping Stone Opening',
    namedAncestor: names[0],
    suggestionNeeded: false,
  });
});

test('an unnamed branch uses its nearest named ancestor plus the last move', () => {
  const variation = openingNameForLine(names, ['d8-c7', 'd2-c3', 'c7-d6', 'e2-e3']);
  assert.equal(variation.label, 'Skipping Stone: Crane Lift: e2-e3');
  assert.equal(variation.inherited, true);
  assert.equal(variation.suggestionNeeded, true);
});

test('a line with no named ancestor asks the player for one', () => {
  assert.equal(
    openingNameForLine(names, ['f8-g7']).label,
    'Suggest a name · f8-g7',
  );
  assert.equal(openingKind(['d8-c7']), 'Opening');
  assert.equal(openingKind(['d8-c7', 'd2-c3']), 'Defense');
  assert.equal(openingKind(['d8-c7', 'd2-c3', 'c7-d6']), 'Variation');
});

test('the explorer follows the imported response tree', () => {
  const reply: OpeningNode = {
    turn: 'Blue',
    score: 0,
    depth: 1,
    selectiveDepth: 1,
    nodes: 0,
    moves: [],
  };
  const root: OpeningNode = {
    turn: 'Red',
    score: 0,
    depth: 0,
    selectiveDepth: 0,
    nodes: 0,
    moves: [{ move: 'd8-c7', rank: 1, score: 0, child: reply }],
  };
  assert.equal(nodeAtLine(root, []), root);
  assert.equal(nodeAtLine(root, ['d8-c7']), reply);
  assert.equal(nodeAtLine(root, ['f8-g7']), null);
});

test('curator imports must match the selected mode and format', () => {
  const book = {
    format: 'rps-opening-book/v1',
    modeId: 'V3',
    mainLine: [],
    positionCount: 0,
    root: { moves: [] },
  };
  assert.equal(validateOpeningBookDocument(book, 'V3'), book);
  assert.throws(() => validateOpeningBookDocument(book, 'V5'), /not V5/);
  assert.throws(
    () => validateOpeningBookDocument({ ...book, format: 'something-else' }, 'V3'),
    /Expected rps-opening-book\/v1/,
  );
});
