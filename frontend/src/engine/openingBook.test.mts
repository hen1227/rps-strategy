import assert from 'node:assert/strict';
import test from 'node:test';

import {
  OPENING_PLIES,
  canonicalOpeningLine,
  lineKey,
  mirrorOpeningLine,
  openingKind,
  openingNaming,
  openingOfGame,
  seedOpeningCache,
  withPublishedName,
  withSuggestion,
  withoutOpeningName,
  withoutSuggestion,
} from './openingBook';

import type {
  OpeningBookBootstrap,
  OpeningName,
  OpeningNameSuggestion,
  OpeningNodeView,
} from './openingBook';

const names: OpeningName[] = [
  { modeId: 'V3', line: ['d8-c7'], name: 'Skipping Stone Opening' },
  { modeId: 'V3', line: ['d8-c7', 'd2-c3', 'c7-d6'], name: 'Skipping Stone: Crane Lift' },
];

const naming = openingNaming({ names });

test('exact names override inherited opening labels', () => {
  assert.deepEqual(naming.titleFor(['d8-c7']), {
    exact: true,
    inherited: false,
    label: 'Skipping Stone Opening',
    namedAncestor: names[0],
    suggestionNeeded: false,
  });
});

test('an unnamed branch uses its nearest named ancestor plus the last move', () => {
  const variation = naming.titleFor(['d8-c7', 'd2-c3', 'c7-d6', 'e2-e3']);
  assert.equal(variation.label, 'Skipping Stone: Crane Lift: e2-e3');
  assert.equal(variation.inherited, true);
  assert.equal(variation.suggestionNeeded, true);
});

test('a line with no named ancestor asks the player for one', () => {
  assert.equal(naming.titleFor(['f8-g7']).label, 'Suggest a name · f8-g7');
  assert.equal(openingKind(['d8-c7']), 'Opening');
  assert.equal(openingKind(['d8-c7', 'd2-c3']), 'Defense');
  assert.equal(openingKind(['d8-c7', 'd2-c3', 'c7-d6']), 'Variation');
});

// ---------------------------------------------------------------------------
// Mirror-image lines
// ---------------------------------------------------------------------------

test('a line and its mirror are one opening with one name', () => {
  assert.deepEqual(mirrorOpeningLine(['d8-c7', 'f2-g3']), ['f8-g7', 'd2-c3']);
  // The middle file is its own mirror, and so is a line that stays on it.
  assert.deepEqual(mirrorOpeningLine(['e8-e7']), ['e8-e7']);

  const mirrored = openingNaming({ names, mirrorNaming: true });
  assert.equal(mirrored.titleFor(['f8-g7']).label, 'Skipping Stone Opening');
  assert.equal(mirrored.nameFor(['f8-g7'])?.name, 'Skipping Stone Opening');
  assert.deepEqual(mirrored.mirrorOf(['d8-c7']), ['f8-g7']);
  assert.equal(mirrored.mirrorOf(['e8-e7']), null);

  // Without the rule -- a mode whose opening layout is lopsided -- the two
  // wings really are two openings, and naming one leaves the other unnamed.
  assert.equal(naming.nameFor(['f8-g7']), null);
});

test('a line mirrors as a whole, never move by move', () => {
  // Per-move canonicalization would take `d8-c7` from one and `d2-c3` from
  // the other and produce a line nobody can play.
  const canonical = canonicalOpeningLine(['f8-g7', 'd2-c3'], true);
  assert.equal(lineKey(canonical), 'd8-c7 f2-g3');
  assert.equal(lineKey(canonicalOpeningLine(['d8-c7', 'f2-g3'], true)), lineKey(canonical));

  // Every prefix of a canonical line is canonical, which is what lets the
  // hierarchy walk prefixes to find an ancestor.
  for (let length = 1; length <= canonical.length; length += 1) {
    const prefix = canonical.slice(0, length);
    assert.deepEqual(canonicalOpeningLine(prefix, true), prefix);
  }

  // The inheritance follows through the mirror: a named line names its twin,
  // and the twin's children inherit from it.
  const mirrored = openingNaming({ names, mirrorNaming: true });
  assert.equal(mirrored.titleFor(['f8-g7', 'e2-e3']).label, 'Skipping Stone Opening: e2-e3');
});

// ---------------------------------------------------------------------------
// Names people have put forward
// ---------------------------------------------------------------------------

const suggestion = (
  suggestionId: number,
  line: string[],
  name: string,
  createdAtUnixMs = suggestionId,
): OpeningNameSuggestion => ({ suggestionId, modeId: 'V3', line, name, createdAtUnixMs });

test('an unnamed line shows every name anybody has put forward for it', () => {
  const withNames = openingNaming({
    names,
    mirrorNaming: true,
    suggestions: [
      suggestion(2, ['f8-g7', 'd2-c3'], 'Twin Defense'),
      suggestion(1, ['d8-c7', 'f2-g3'], 'Crane Lift'),
      suggestion(3, ['h8-g7'], 'The Long Walk'),
    ],
  });
  // The two mirrored proposals are proposals for one line, oldest first.
  assert.deepEqual(
    withNames.suggestionsFor(['f8-g7', 'd2-c3']).map((entry) => entry.name),
    ['Crane Lift', 'Twin Defense'],
  );
  assert.deepEqual(withNames.suggestionsFor(['d8-c7', 'f2-g3']).map((entry) => entry.name), [
    'Crane Lift',
    'Twin Defense',
  ]);
  assert.equal(withNames.pendingCount, 3);
  assert.equal(withNames.namedCount, 2);
});

test('the queue is shallowest first, and says when a parent is still unnamed', () => {
  const queued = openingNaming({
    names,
    mirrorNaming: true,
    suggestions: [
      suggestion(1, ['d8-c7', 'f2-g3'], 'Crane Lift'),
      suggestion(2, ['h8-g7'], 'The Long Walk'),
      suggestion(3, ['h8-g7', 'b2-c3', 'g7-f6'], 'Long Walk: Detour'),
    ],
  });
  assert.deepEqual(
    queued.queue.map((group) => lineKey(group.line)),
    ['b8-c7', 'd8-c7 f2-g3', 'b8-c7 h2-g3 c7-d6'],
  );

  // `d8-c7 f2-g3` hangs under a named opening. The three-ply line does not:
  // its parent has no name, which is exactly the case that made naming out of
  // order look as though it had thrown a name away.
  const [firstMove, defense, variation] = queued.queue;
  assert.equal(firstMove.parentUnnamed, false);
  assert.equal(firstMove.ancestor, null);
  assert.equal(defense.ancestor?.name, 'Skipping Stone Opening');
  assert.equal(defense.parentUnnamed, false);
  assert.equal(variation.parentUnnamed, true);
});

// ---------------------------------------------------------------------------
// Keeping the page in step
// ---------------------------------------------------------------------------

const book = (extra: Partial<OpeningBookBootstrap> = {}): OpeningBookBootstrap => ({
  modeId: 'V3',
  rootKey: 'r',
  positionCount: 1,
  mainLine: [],
  featured: [],
  mirrorNaming: true,
  names: [...names],
  suggestions: [
    suggestion(1, ['d8-c7'], 'Skipping Stone Opening'),
    suggestion(2, ['d8-c7'], 'The Long Walk'),
    suggestion(3, ['d8-c7', 'f2-g3'], 'Crane Lift'),
  ],
  root: { key: 'r', turn: 'Red', score: 0, depth: 0, selectiveDepth: 0, nodes: 0, moves: [] },
  featuredPositions: [],
  ...extra,
});

test('publishing a name answers that line and leaves the rest of the queue alone', () => {
  // Naming the second move before the first is the order that used to read as
  // though the first move's suggestion had been overwritten.
  const published = withPublishedName(book(), {
    modeId: 'V3',
    line: ['d8-c7', 'f2-g3'],
    name: 'Crane Lift',
  });
  assert.deepEqual(
    published.suggestions.map((entry) => entry.name),
    ['Skipping Stone Opening', 'The Long Walk'],
  );
  assert.equal(published.names.length, 3);

  // A name published against the mirror replaces the name on the same line
  // rather than adding a second one.
  const renamed = withPublishedName(book(), {
    modeId: 'V3',
    line: ['f8-g7'],
    name: 'The Skipping Stone',
  });
  const after = openingNaming(renamed);
  assert.equal(
    renamed.names.filter((entry) => lineKey(after.canonical(entry.line)) === 'd8-c7').length,
    1,
  );
  assert.equal(after.nameFor(['d8-c7'])?.name, 'The Skipping Stone');
  // Its proposals were answered; the deeper line's were not.
  assert.deepEqual(renamed.suggestions.map((entry) => entry.suggestionId), [3]);
});

test('a removed name unnames the line, and a rejected suggestion leaves the others', () => {
  const unnamed = withoutOpeningName(book(), ['f8-g7']);
  assert.equal(openingNaming(unnamed).nameFor(['d8-c7']), null);
  assert.equal(unnamed.suggestions.length, 3);

  const rejected = withoutSuggestion(book(), 2);
  assert.deepEqual(rejected.suggestions.map((entry) => entry.suggestionId), [1, 3]);

  const added = withSuggestion(rejected, suggestion(4, ['d8-c7'], 'Something Else'));
  assert.deepEqual(added.suggestions.map((entry) => entry.suggestionId), [1, 3, 4]);
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
  suggestions: [],
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

// ---------------------------------------------------------------------------
// The opening a game is playing
// ---------------------------------------------------------------------------

const played = (...line: string[]) => line;

test('a game is called by the deepest name along the line it played', () => {
  const opening = openingOfGame(
    naming,
    played('d8-c7', 'd2-c3', 'c7-d6', 'e2-e3', 'd6-e5'),
  );
  assert.equal(opening?.name?.name, 'Skipping Stone: Crane Lift');
  assert.deepEqual(opening?.line, ['d8-c7', 'd2-c3', 'c7-d6']);
});

// Deepest for what it is called, shallowest for what wants naming: the book
// reads strangely when a variation is named under an opening that is not.
test('the line a game offers up is the shallowest one with no name', () => {
  const opening = openingOfGame(naming, played('d8-c7', 'd2-c3', 'c7-d6', 'e2-e3'));
  assert.deepEqual(opening?.wants, ['d8-c7', 'd2-c3']);
});

test('a game nobody has named anywhere is offered as its first move', () => {
  const opening = openingOfGame(naming, played('f8-e7', 'd2-c3', 'e7-e6'));
  assert.equal(opening?.name, null);
  assert.deepEqual(opening?.line, ['f8-e7']);
  assert.deepEqual(opening?.wants, ['f8-e7']);
  assert.equal(opening?.title.label, 'Suggest a name · f8-e7');
});

test('a game whose whole opening is named has nothing to ask for', () => {
  const opening = openingOfGame(naming, played('d8-c7'));
  assert.equal(opening?.name?.name, 'Skipping Stone Opening');
  assert.equal(opening?.wants, null);
});

test('a game with no moves has no opening', () => {
  assert.equal(openingOfGame(naming, []), null);
  assert.equal(openingOfGame(naming, undefined), null);
});

// The opening ends somewhere. A twentieth move is a position, not an idea, and
// asking anybody to name one would be asking for the wrong thing.
test('the opening stops at its depth, however long the game ran', () => {
  const long = Array.from({ length: OPENING_PLIES + 6 }, (_unused, ply) => `a${ply % 9 + 1}-b1`);
  const opening = openingOfGame(openingNaming({ names: [] }), long, 3);
  assert.deepEqual(opening?.line, [long[0]]);
  assert.equal(openingOfGame(openingNaming({ names: [] }), long)?.wants?.length, 1);
});

// Mirrored games are the same opening, so the name found for one is the name
// found for the other.
test('a game playing the mirror of a named line is called by its name', () => {
  const mirrored = openingNaming({ names, mirrorNaming: true });
  const opening = openingOfGame(mirrored, played('f8-g7', 'f2-g3'));
  assert.equal(opening?.name?.name, 'Skipping Stone Opening');
  assert.deepEqual(opening?.line, ['f8-g7']);
  assert.deepEqual(opening?.wants, ['f8-g7', 'f2-g3']);
});
