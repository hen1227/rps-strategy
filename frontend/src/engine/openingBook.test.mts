import assert from 'node:assert/strict';
import test from 'node:test';

import {
  lineKey,
  nodeAtLine,
  openingKind,
  openingNameForLine,
  seedOpeningCache,
  validateOpeningBookDocument,
} from './openingBook';

import type {
  OpeningBookBootstrap,
  OpeningName,
  OpeningNode,
  OpeningNodeView,
} from './openingBook';

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
    /Expected rps-opening-book\/v2 or rps-opening-book\/v1/,
  );

  // The graph is what the engine writes now, so the studio has to take it.
  const graph = {
    format: 'rps-opening-book/v2',
    modeId: 'V3',
    rootKey: 'r',
    positionCount: 1,
    mainLine: [],
    featured: [],
    positions: [{ key: 'r', turn: 'Red', score: 0, depth: 0, selectiveDepth: 0, nodes: 0, moves: [] }],
  };
  assert.equal(validateOpeningBookDocument(graph, 'V3'), graph);
  assert.throws(() => validateOpeningBookDocument(graph, 'V5'), /not V5/);
  assert.throws(
    () => validateOpeningBookDocument({ ...graph, positions: [] }, 'V3'),
    /graph is incomplete/,
  );
});

// ---------------------------------------------------------------------------
// The served graph
// ---------------------------------------------------------------------------

const view = (
  key: string,
  turn: string,
  moves: OpeningNodeView['moves'],
): OpeningNodeView => ({ key, turn, score: 0, depth: 1, selectiveDepth: 1, nodes: 0, moves });

// `d8-c7 d2-c3` and `f8-g7 f2-g3` are the same board by two move orders, which
// is exactly what a position-keyed graph merges and a tree cannot.
const bootstrap: OpeningBookBootstrap = {
  modeId: 'V3',
  rootKey: 'r',
  positionCount: 4,
  mainLine: ['d8-c7', 'd2-c3'],
  featured: [
    ['d8-c7', 'd2-c3'],
    ['f8-g7', 'f2-g3'],
  ],
  names: [],
  root: view('r', 'Red', [
    { move: 'd8-c7', rank: 1, score: 9, searched: true, mainLine: true, child: 'x' },
    { move: 'f8-g7', rank: 2, score: 4, searched: true, child: 'y' },
  ]),
  featuredPositions: [
    view('x', 'Blue', [{ move: 'd2-c3', rank: 1, score: -9, searched: true, child: 'z' }]),
    view('y', 'Blue', [{ move: 'f2-g3', rank: 1, score: -4, searched: true, child: 'z' }]),
    view('z', 'Red', []),
  ],
};

test('the bootstrap seeds a cache for every featured line', () => {
  const cache = seedOpeningCache(bootstrap);
  assert.equal(cache.get(lineKey([]))?.key, 'r');
  assert.equal(cache.get(lineKey(['d8-c7']))?.key, 'x');
  assert.equal(cache.get(lineKey(['f8-g7']))?.key, 'y');
  // Both featured lines transpose into one position, and both reach it.
  assert.equal(cache.get(lineKey(['d8-c7', 'd2-c3']))?.key, 'z');
  assert.equal(cache.get(lineKey(['f8-g7', 'f2-g3']))?.key, 'z');
  // A line nobody featured is a fetch, which is the whole point.
  assert.equal(cache.get(lineKey(['d8-c7', 'f2-g3'])), undefined);
});

test('a featured line stops at the first move the payload cannot follow', () => {
  const truncated: OpeningBookBootstrap = {
    ...bootstrap,
    featured: [['d8-c7', 'd2-c3', 'c7-d6']],
    featuredPositions: bootstrap.featuredPositions.filter((position) => position.key !== 'z'),
  };
  const cache = seedOpeningCache(truncated);
  assert.equal(cache.get(lineKey(['d8-c7']))?.key, 'x');
  assert.equal(cache.get(lineKey(['d8-c7', 'd2-c3'])), undefined);
});

test('an empty bootstrap seeds an empty cache rather than throwing', () => {
  assert.equal(seedOpeningCache(null).size, 0);
});
