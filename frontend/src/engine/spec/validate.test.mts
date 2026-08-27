// The validator, checked on the two specs that have to pass and on the mistakes
// an author (or an agent) will actually make.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { INFILTRATION_SPEC, TOTAL_WAR_SPEC } from '@/engine/spec/builtin';
import { SPEC_LIMITS, describeReport, isValid, validateSpec } from '@/engine/spec/validate';
import { SPEC_VERSION, type RuleSpec } from '@/engine/spec/types';

/** A spec with one field replaced, so each case reads as its own difference. */
const withChange = (change: Partial<Record<string, unknown>>): unknown => ({
  ...TOTAL_WAR_SPEC,
  ...change,
});

const paths = (issues: { path: string }[]) => issues.map((issue) => issue.path);

test('the two shipped modes are valid, with nothing to warn about', () => {
  for (const spec of [TOTAL_WAR_SPEC, INFILTRATION_SPEC]) {
    const report = validateSpec(spec);
    assert.deepEqual(report.errors, [], `${spec.name}: ${describeReport(report)}`);
    assert.deepEqual(report.warnings, [], `${spec.name}: ${JSON.stringify(report.warnings)}`);
    assert.ok(isValid(report));
    assert.equal(describeReport(report), 'valid');
  }
});

test('a spec from another language version is refused, and nothing else is said', () => {
  const report = validateSpec({ ...TOTAL_WAR_SPEC, spec: SPEC_VERSION + 1 });
  assert.deepEqual(paths(report.errors), ['spec']);
});

test('what is not a spec at all', () => {
  for (const candidate of [null, 42, 'spec', [], undefined]) {
    assert.ok(!isValid(validateSpec(candidate)), JSON.stringify(candidate));
  }
});

test('a movement rule naming a piece that does not exist', () => {
  const report = validateSpec(
    withChange({ movement: [{ kind: 'step', dirs: 'all8', piece: 'Lizard' }] }),
  );
  assert.deepEqual(paths(report.errors), ['movement[0].piece']);
});

test('a layout that is not the board it declares', () => {
  const report = validateSpec(
    withChange({ board: { width: 5, height: 5 } }),
  );
  assert.ok(paths(report.errors).includes('startingPosition.rows'));
});

test('a symbol in the layout with no piece behind it', () => {
  const rows = [...TOTAL_WAR_SPEC.startingPosition.rows];
  rows[4] = '....X....';
  const report = validateSpec(withChange({ startingPosition: { rows } }));
  assert.deepEqual(paths(report.errors), ['startingPosition.rows[4]']);
});

test('two pieces cannot share a letter, because a layout could not tell them apart', () => {
  const report = validateSpec(
    withChange({
      pieces: [
        { id: 'Rock', name: 'Rock', symbol: 'R' },
        { id: 'Ruin', name: 'Ruin', symbol: 'R' },
      ],
    }),
  );
  assert.ok(paths(report.errors).includes('pieces[1].symbol'));
});

test('a piece cannot be called Empty, because that is what no piece is called', () => {
  const report = validateSpec(
    withChange({ pieces: [{ id: 'Empty', name: 'Nothing', symbol: 'E' }] }),
  );
  assert.ok(paths(report.errors).includes('pieces[0].id'));
});

test('a lower-case symbol has no room left to say whose piece it is', () => {
  const report = validateSpec(
    withChange({ pieces: [{ id: 'Rock', name: 'Rock', symbol: 'r' }] }),
  );
  assert.ok(paths(report.errors).includes('pieces[0].symbol'));
});

test('a kind may capture its own kind, the way a chess pawn does', () => {
  const report = validateSpec(withChange({ beats: [['Rock', 'Rock']] }));
  assert.deepEqual(paths(report.errors), []);
});

test('a pair cannot be written twice', () => {
  const duplicate = validateSpec(
    withChange({
      beats: [
        ['Rock', 'Scissors'],
        ['Rock', 'Scissors'],
      ],
    }),
  );
  assert.ok(paths(duplicate.errors).includes('beats[1]'));
});

test('a piece nothing captures is a warning, not an error', () => {
  // Rock-Paper-Scissors-Lizard-Spock's real graph, minus one edge, so nothing
  // takes the lizard. Legal — a mode may want an untouchable piece — but almost
  // certainly not what the author meant.
  const report = validateSpec(
    withChange({
      pieces: [
        { id: 'Rock', name: 'Rock', symbol: 'R' },
        { id: 'Paper', name: 'Paper', symbol: 'P' },
        { id: 'Scissors', name: 'Scissors', symbol: 'S' },
        { id: 'Lizard', name: 'Lizard', symbol: 'L' },
      ],
      beats: [
        ['Rock', 'Scissors'],
        ['Scissors', 'Paper'],
        ['Paper', 'Rock'],
        ['Lizard', 'Paper'],
      ],
      movement: [{ kind: 'step', dirs: 'all8', distance: 1 }],
    }),
  );
  assert.deepEqual(paths(report.errors), []);
  assert.ok(
    report.warnings.some((issue) => issue.path === 'beats' && issue.message.includes('Lizard')),
  );
});

test('a piece with no movement rule is a warning', () => {
  const report = validateSpec(
    withChange({ movement: [{ kind: 'step', dirs: 'all8', piece: 'Rock' }] }),
  );
  assert.deepEqual(paths(report.errors), []);
  assert.ok(report.warnings.some((issue) => issue.message.includes('"Paper"')));
});

test('nothing can move at all', () => {
  assert.ok(paths(validateSpec(withChange({ movement: [] })).errors).includes('movement'));
});

test('a predicate with a hole in it', () => {
  const report = validateSpec(
    withChange({
      win: [{ when: { eq: [{ count: { owner: 'nobody' } }, 0] }, result: 'mover' }],
    }),
  );
  assert.ok(paths(report.errors).includes('win[0].when.eq[0].count.owner'));
});

test('a condition naming two kinds at once', () => {
  const report = validateSpec(
    withChange({ win: [{ when: { captured: true, moved: 'rock' }, result: 'mover' }] }),
  );
  assert.ok(paths(report.errors).includes('win[0].when'));
});

test('a region off the edge of the board it is for', () => {
  const report = validateSpec(
    withChange({ win: [{ when: { in: ['to', { rows: [12] }] }, result: 'mover' }] }),
  );
  assert.ok(paths(report.errors).includes('win[0].when.in[1].rows[0]'));
});

test('a predicate nested past the depth cap', () => {
  let predicate: unknown = true;
  for (let depth = 0; depth <= SPEC_LIMITS.depth + 2; depth += 1) {
    predicate = { not: predicate };
  }
  const report = validateSpec(withChange({ win: [{ when: predicate, result: 'mover' }] }));
  assert.ok(report.errors.some((issue) => issue.message.includes('nested deeper')));
});

test('a direction offset that goes nowhere, or further than any board', () => {
  const nowhere = validateSpec(
    withChange({ movement: [{ kind: 'leap', dirs: { offsets: [[0, 0]] } }] }),
  );
  assert.ok(paths(nowhere.errors).includes('movement[0].dirs.offsets[0]'));
  const tooFar = validateSpec(
    withChange({ movement: [{ kind: 'leap', dirs: { offsets: [[99, 1]] } }] }),
  );
  assert.ok(paths(tooFar.errors).includes('movement[0].dirs.offsets[0]'));
});

test('a board outside the sizes this project can play', () => {
  for (const board of [
    { width: 2, height: 9 },
    { width: 9, height: 40 },
    { width: 26, height: 26 },
  ]) {
    assert.ok(paths(validateSpec(withChange({ board })).errors).includes('board'), JSON.stringify(board));
  }
});

test('a promotion to a piece the mode does not have', () => {
  const report = validateSpec(
    withChange({ effects: [{ on: 'move', do: [{ promote: { to: 'queen' } }] }] }),
  );
  assert.ok(paths(report.errors).includes('effects[0].do[0].promote.to'));
});

test('a jump feature, written the way a reusable part would be inlined', () => {
  // The shape `{ use: 'jump@1' }` resolves to. This is the check that the
  // language can express the reuse example without a special case for it.
  const report = validateSpec(
    withChange({
      movement: [
        { kind: 'step', dirs: 'all8', distance: 1 },
        { kind: 'jumpOver', dirs: 'all8', captureJumped: true, piece: 'Rock' },
      ],
    }),
  );
  assert.deepEqual(report.errors, [], describeReport(report));
});

test('a mode with no win condition is legal and says so', () => {
  const report = validateSpec(withChange({ win: [] }));
  assert.deepEqual(report.errors, []);
  assert.ok(report.warnings.some((issue) => issue.path === 'win'));
});

test('blank text, over-long text, and control characters in a name', () => {
  assert.ok(paths(validateSpec(withChange({ name: '  ' })).errors).includes('name'));
  assert.ok(
    paths(validateSpec(withChange({ description: 'x'.repeat(SPEC_LIMITS.text + 1) })).errors).includes(
      'description',
    ),
  );
  const control = validateSpec(withChange({ name: `Total${String.fromCharCode(7)}War` }));
  assert.ok(paths(control.errors).includes('name'));
});

test('a spec bigger than a published mode may be', () => {
  const bloated: RuleSpec = {
    ...TOTAL_WAR_SPEC,
    // Legal in every part, and far too much of it: the size cap is the only
    // thing that catches this.
    win: Array.from({ length: SPEC_LIMITS.win }, () => ({
      when: {
        or: Array.from({ length: 40 }, () => ({
          eq: [{ count: { piece: 'Rock', owner: 'mover' } }, 3] as [never, never],
        })),
      },
      result: 'mover' as const,
      reason: 'game_rule',
    })),
  };
  const report = validateSpec(bloated);
  assert.ok(report.errors.some((issue) => issue.message.includes('bytes')), describeReport(report));
});

/* ------------------------------------------------------------------- art -- */

/** A digest-shaped id, so a case reads as its own difference and not as hex. */
const ART = (fill: string) => `img:${fill.repeat(32).slice(0, 32)}`;

const pieceWithArt = (art: unknown) =>
  withChange({
    pieces: TOTAL_WAR_SPEC.pieces.map((piece, index) =>
      index === 0 ? { ...piece, art } : piece,
    ),
  });

test('an art name this build does not know costs the picture, not the mode', () => {
  const report = validateSpec(pieceWithArt('lizard'));
  assert.deepEqual(report.errors, [], describeReport(report));
  assert.deepEqual(paths(report.warnings), ['pieces[0].art']);
});

test('a picture is referenced, and the reference is what a bundled name is not', () => {
  const report = validateSpec(pieceWithArt(ART('a')));
  assert.deepEqual(report.errors, [], describeReport(report));
  assert.deepEqual(report.warnings, []);
});

test('a malformed picture id is an error, because nothing will ever resolve it', () => {
  for (const bad of ['img:', 'img:nothex', 'img:../../admin', ART('A'), `${ART('a')}0`]) {
    const report = validateSpec(pieceWithArt(bad));
    assert.deepEqual(paths(report.errors), ['pieces[0].art'], bad);
  }
});

test('the board and the cover take a picture, and nothing else', () => {
  const good = validateSpec(
    withChange({
      board: { ...TOTAL_WAR_SPEC.board, art: ART('b') },
      cover: ART('c'),
    }),
  );
  assert.deepEqual(good.errors, [], describeReport(good));

  // No bundled board or cover exists to name, so a name is a mistake here even
  // though the identical string is only a warning on a piece.
  const named = validateSpec(withChange({ board: { ...TOTAL_WAR_SPEC.board, art: 'rock' } }));
  assert.deepEqual(paths(named.errors), ['board.art']);
});

test('every slot in a mode can carry its own picture at once', () => {
  const report = validateSpec(
    withChange({
      pieces: TOTAL_WAR_SPEC.pieces.map((piece, index) => ({
        ...piece,
        art: ART(String(index)),
      })),
      board: { ...TOTAL_WAR_SPEC.board, art: ART('d') },
      cover: ART('e'),
    }),
  );
  assert.deepEqual(report.errors, [], describeReport(report));
});

test('pictures cost the document almost nothing, which is the whole design', () => {
  const withArt = withChange({
    pieces: TOTAL_WAR_SPEC.pieces.map((piece, index) => ({ ...piece, art: ART(String(index)) })),
    board: { ...TOTAL_WAR_SPEC.board, art: ART('d') },
    cover: ART('e'),
  }) as RuleSpec;
  const grew = JSON.stringify(withArt).length - JSON.stringify(TOTAL_WAR_SPEC).length;
  assert.ok(grew < 300, `five pictures added ${grew} bytes`);
  assert.deepEqual(validateSpec(withArt).errors, []);
});
