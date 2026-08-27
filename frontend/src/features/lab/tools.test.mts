// Every tool, driven through a controller made of plain objects.
//
// No browser, no agent, no server. The tools are the operations the Lab offers,
// so this is the test that says they work — and the reason they were written as
// functions over a controller rather than as handlers bolted to a screen.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  applyAnalysisMove,
  createAnalysisGame,
  allValidMoves,
  validMovesFor,
  type AnalysisGame,
} from '@/engine/analysisGame';
import { TOTAL_WAR_SPEC } from '@/engine/spec/builtin';
import { standardRows } from '@/engine/spec/position';
import { CORPUS_SPECS } from '@/engine/spec/conformance/specs';
import { modeDefinitionFor } from '@/engine/spec/interpret';
import { simulate } from '@/engine/spec/simulate';
import { validateSpec } from '@/engine/spec/validate';
import { labTools, mirrorRows, type LabController } from '@/features/lab/tools';
import type { RuleSpec } from '@/engine/spec/types';
import type { LabArtAsset, LibraryPart } from '@/store/api/lab';
import type { LabToolCall } from '@/store/labSession';
import type { Position } from '@/types/game';

/** A controller over plain state, so a test can watch what a tool did. */
const fakeController = (
  options: {
    spec?: RuleSpec;
    confirm?: boolean;
    signedIn?: boolean;
    /** What a person "presses" when a tool asks. `null` is them ignoring it. */
    answer?: { id?: string; text?: string } | null;
    /** Whether they take a proposed change. */
    accept?: boolean;
  } = {},
) => {
  let draft = options.spec ?? TOTAL_WAR_SPEC;
  let game: AnalysisGame | null = null;
  let history: AnalysisGame[] = [];
  const published: unknown[] = [];
  const drafts = new Map<string, RuleSpec>();
  const parts: LibraryPart[] = [
    {
      partId: 'jump',
      version: 1,
      ownerUserId: 'someone',
      ownerUsername: 'Someone',
      kind: 'movement',
      name: 'Jump',
      summary: 'Leap the adjacent piece and land beyond it.',
      body: { kind: 'jumpOver', dirs: 'all8', captureJumped: true },
      usedBy: 3,
      publishedAtUnixMs: 0,
    },
  ];

  // A digest-shaped id per picture, so a test can assert on a reference without
  // hashing anything.
  const stored: LabArtAsset[] = [];
  const nextArtID = () => `img:${String(stored.length + 1).padStart(32, '0')}`;

  const proposed: unknown[] = [];
  const activity: LabToolCall[] = [];
  let pointing: unknown = null;

  const controller: LabController = {
    getDraft: () => draft,
    setDraft: (spec) => {
      draft = spec;
      game = null;
      history = [];
      return validateSpec(spec);
    },
    validate: (spec) => validateSpec(spec),
    getGame: () => game,
    newGame: (opts) => {
      if (validateSpec(draft).errors.length > 0) return null;
      game = createAnalysisGame(
        modeDefinitionFor(draft, 'test'),
        opts?.rows ? { rows: opts.rows } : draft.startingPosition,
      );
      history = [];
      return game;
    },
    endGame: () => {
      game = null;
    },
    legalMoves: (from?: Position) => {
      if (!game) return [];
      if (!from) return allValidMoves(game);
      return validMovesFor(game, from).map((to) => ({ from, to }));
    },
    play: (from: Position, to: Position) => {
      if (!game) return false;
      const played = applyAnalysisMove(game, from, to);
      if (!played) return false;
      history.push(game);
      game = played.game;
      return true;
    },
    undo: () => {
      const previous = history.pop();
      if (!previous) return false;
      game = previous;
      return true;
    },
    simulate: (opts) => simulate(draft, { games: 6, plyLimit: 60, ...opts }),
    getSimulation: () => null,
    language: async () => '# RuleSpec\n\nThe reference.',
    searchParts: async ({ kind, search }) =>
      parts.filter(
        (part) =>
          (!kind || part.kind === kind) &&
          (!search || part.name.toLowerCase().includes(search.toLowerCase())),
      ),
    getPart: async (partId) => parts.find((part) => partId.startsWith(part.partId)) ?? null,
    publishMode: async (input) => {
      published.push(input);
      return { modeId: `custom:${input.slug}@1`, url: `https://example.test/library` };
    },
    publishPart: async (input) => {
      published.push(input);
      return { partId: input.partId, version: 1 };
    },
    canAddImage: () => options.signedIn ?? true,
    addImage: async (input) => {
      const asset: LabArtAsset = {
        artId: nextArtID(),
        mediaType: 'image/png',
        width: 512,
        height: 512,
        bytes: 4096,
        role: input.role,
        published: false,
        createdAtUnixMs: 0,
      };
      stored.push(asset);
      return asset;
    },
    listImages: async () => [...stored],
    saveDraft: async (name) => {
      drafts.set('d1', { ...draft, name });
      return { draftId: 'd1' };
    },
    listDrafts: async () => [...drafts.entries()].map(([draftId, spec]) => ({ draftId, name: spec.name })),
    loadDraft: async (draftId) => drafts.get(draftId) ?? null,
    confirm: async () => options.confirm ?? true,
    ask: async () => (options.answer === undefined ? { id: 'option-0' } : options.answer),
    propose: async (proposal) => {
      const applied = options.accept ?? true;
      if (applied) {
        draft = proposal.spec;
        game = null;
        history = [];
      }
      proposed.push(proposal);
      return { applied };
    },
    highlight: (next) => {
      pointing = next;
    },
    activity: () => activity,
  };
  return {
    controller,
    published,
    stored,
    proposed,
    activity,
    get pointing() {
      return pointing;
    },
    get draft() {
      return draft;
    },
    get game() {
      return game;
    },
  };
};

const toolNamed = (controller: LabController, name: string) => {
  const tool = labTools(controller).find((entry) => entry.name === name);
  assert.ok(tool, `no tool called ${name}`);
  return tool;
};

const run = async (controller: LabController, name: string, input: Record<string, unknown> = {}) => {
  const outcome = (await toolNamed(controller, name).execute(input)) as Record<string, unknown>;
  return outcome;
};

test('every tool has a description and a schema, because that is what an agent reads', () => {
  const { controller } = fakeController();
  for (const tool of labTools(controller)) {
    assert.ok(tool.description.length > 40, `${tool.name} needs a real description`);
    assert.ok(tool.inputSchema, `${tool.name} needs an input schema`);
    assert.match(tool.name, /^lab_[a-z_]+$/, `${tool.name} is oddly named`);
  }
});

test('the tool surface changes with the page: no move tools until there is a game', async () => {
  const { controller } = fakeController();
  const before = labTools(controller).map((tool) => tool.name);
  assert.ok(!before.includes('lab_play_move'));
  assert.ok(!before.includes('lab_legal_moves'));

  await run(controller, 'lab_new_test_game');
  const after = labTools(controller).map((tool) => tool.name);
  assert.ok(after.includes('lab_play_move'));
  assert.ok(after.includes('lab_legal_moves'));
  assert.ok(after.includes('lab_undo'));
});

test('the state tool leads with something readable and carries the data too', async () => {
  const { controller } = fakeController();
  const state = await run(controller, 'lab_get_state');
  assert.match(String(state.summary), /9 by 9/);
  assert.match(String(state.summary), /3 piece kinds/);
  assert.ok(state.spec);
  assert.deepEqual((state.validation as { errors: unknown[] }).errors, []);
});

test('patching reaches any field of the language', async () => {
  const harness = fakeController();
  const patched = await run(harness.controller, 'lab_patch_spec', {
    patch: {
      name: 'Jumpers',
      movement: [
        { kind: 'step', dirs: 'all8', distance: 1 },
        { kind: 'jumpOver', dirs: 'all8', captureJumped: true },
      ],
    },
  });
  assert.match(String(patched.summary), /Changed name, movement/);
  assert.equal(harness.draft.name, 'Jumpers');
  assert.equal(harness.draft.movement.length, 2);
  // And the rest of the mode is untouched.
  assert.equal(harness.draft.board.width, 9);
});

test('a patch that breaks the rules says so rather than failing silently', async () => {
  const harness = fakeController();
  const patched = await run(harness.controller, 'lab_patch_spec', {
    patch: { movement: [{ kind: 'step', dirs: 'all8', piece: 'Lizard' }] },
  });
  assert.match(String(patched.summary), /error/);
  const validation = patched.validation as { valid: boolean; errors: { path: string }[] };
  assert.equal(validation.valid, false);
  assert.equal(validation.errors[0]?.path, 'movement[0].piece');
});

test('a game cannot be started while the rules have errors', async () => {
  const harness = fakeController();
  await run(harness.controller, 'lab_patch_spec', { patch: { movement: [] } });
  const started = await run(harness.controller, 'lab_new_test_game');
  assert.equal(started.started, false);
  assert.match(String(started.summary), /Cannot start a game/);
});

test('the board comes back as something a model can read', async () => {
  const { controller } = fakeController();
  const started = await run(controller, 'lab_new_test_game');
  const drawing = String(started.summary);
  assert.match(drawing, /Red to move/);
  // Rank 1 is Blue's home, so its scissors are upper case; rank 9 is Red's.
  assert.match(drawing, / 1 \.\.\.SSS\.\.\./);
  assert.match(drawing, / 9 \.\.\.sss\.\.\./);
  assert.match(drawing, /abcdefghi/);
});

test('playing a move, and being told when one is not legal', async () => {
  const { controller } = fakeController();
  await run(controller, 'lab_new_test_game');

  const illegal = await run(controller, 'lab_play_move', { from: 'a1', to: 'a2' });
  assert.equal(illegal.played, false);
  assert.match(String(illegal.summary), /not legal/);
  assert.ok(Array.isArray(illegal.legalMoves));

  const legal = await run(controller, 'lab_play_move', { from: 'd7', to: 'd6' });
  assert.equal(legal.played, true);
  assert.match(String(legal.summary), /Blue to move/);

  const undone = await run(controller, 'lab_undo');
  assert.equal(undone.undone, true);
  assert.match(String(undone.summary), /Red to move/);
});

test('legal moves are the rules answering, not a guess', async () => {
  const { controller } = fakeController();
  await run(controller, 'lab_new_test_game');
  const moves = await run(controller, 'lab_legal_moves');
  const named = moves.moves as string[];
  assert.ok(named.includes('d7-d6'));
  // Red's own pieces are not destinations.
  assert.ok(!named.includes('d7-e7'));
});

test('the playtest reports what never fired, which is the point of it', async () => {
  const { controller } = fakeController({ spec: CORPUS_SPECS.menagerie! });
  const report = await run(controller, 'lab_simulate', { games: 6, strength: 0 });
  assert.match(String(report.summary), /games: Red/);
  assert.ok(Array.isArray(report.winConditionsNeverFired));
  assert.ok(Array.isArray(report.movementRulesNeverUsed));
  assert.ok((report.notes as string[]).length > 0);
});

test('the reusable-parts library is searchable and fetchable', async () => {
  const { controller } = fakeController();
  const found = await run(controller, 'lab_search_parts', { kind: 'movement', search: 'jump' });
  assert.match(String(found.summary), /jump@1/);
  const one = await run(controller, 'lab_get_part', { partId: 'jump@1' });
  assert.ok(one.part);
});

test('publishing asks first, and does not publish when the answer is no', async () => {
  const declining = fakeController({ confirm: false });
  const refused = await run(declining.controller, 'lab_publish_mode', { slug: 'jumpers' });
  assert.equal(refused.published, false);
  assert.match(String(refused.summary), /declined/);
  assert.deepEqual(declining.published, []);

  const agreeing = fakeController({ confirm: true });
  const done = await run(agreeing.controller, 'lab_publish_mode', { slug: 'jumpers' });
  assert.equal(done.published, true);
  assert.equal(done.modeId, 'custom:jumpers@1');
  assert.equal(agreeing.published.length, 1);
});

test('an unplayable mode is never published, whatever anybody says', async () => {
  const harness = fakeController({ confirm: true });
  await run(harness.controller, 'lab_patch_spec', { patch: { movement: [] } });
  const refused = await run(harness.controller, 'lab_publish_mode', { slug: 'broken' });
  assert.equal(refused.published, false);
  assert.deepEqual(harness.published, []);
});

test('a draft survives being saved and loaded back', async () => {
  const harness = fakeController();
  await run(harness.controller, 'lab_patch_spec', { patch: { name: 'Work in progress' } });
  await run(harness.controller, 'lab_save_draft', { name: 'Work in progress' });
  const listed = await run(harness.controller, 'lab_list_drafts');
  assert.match(String(listed.summary), /Work in progress/);

  await run(harness.controller, 'lab_patch_spec', { patch: { name: 'Something else' } });
  const loaded = await run(harness.controller, 'lab_load_draft', { draftId: 'd1' });
  assert.equal(loaded.loaded, true);
  assert.equal(harness.draft.name, 'Work in progress');
});

test('setting a starting position, and mirroring it onto the other half', async () => {
  const harness = fakeController();
  const set = await run(harness.controller, 'lab_set_starting_position', {
    rows: ['RPS......', '.........', '.........'],
    mirror: true,
  });
  const rows = set.rows as string[];
  assert.equal(rows.length, 9);
  assert.equal(rows[0], 'RPS......');
  // The far rank is the near one with the sides swapped.
  assert.equal(rows[8], 'rps......');
});

test('mirroring swaps sides rather than copying them', () => {
  const mirrored = mirrorRows(['RR..', '....'], 4);
  assert.deepEqual(mirrored, ['RR..', '....', '....', 'rr..']);
});

/* -------------------------------------------------- the opening, by default -- */

test('a preset opening is built for the board the mode has now', async () => {
  const harness = fakeController();
  await run(harness.controller, 'lab_set_starting_position', { rows: ['RRRRRRRRR', ...Array(8).fill('.........')] });
  const set = await run(harness.controller, 'lab_set_starting_position', { preset: 'standard' });
  assert.deepEqual(set.rows, TOTAL_WAR_SPEC.startingPosition.rows);
  assert.match(String(set.summary), /standard opening/);
  assert.deepEqual((set.validation as { errors: unknown[] }).errors, []);
});

test('the empty preset clears the board rather than leaving it wrong', async () => {
  const harness = fakeController();
  const set = await run(harness.controller, 'lab_set_starting_position', { preset: 'empty' });
  assert.deepEqual(set.rows, Array(9).fill('.........'));
});

test('a starting position with neither rows nor a preset is refused, not guessed at', async () => {
  const harness = fakeController();
  await assert.rejects(() => run(harness.controller, 'lab_set_starting_position', {}), /preset or the rows/);
});

test('resizing the board keeps a mode that was on the default on the default', async () => {
  const harness = fakeController();
  const patched = await run(harness.controller, 'lab_patch_spec', {
    patch: { board: { width: 11, height: 9 } },
  });
  assert.deepEqual((patched.validation as { errors: unknown[] }).errors, []);
  assert.deepEqual(harness.draft.startingPosition.rows[0], standardRows(harness.draft)[0]);
  assert.match(String(patched.summary), /standard one for the new shape/);
  // And the mode is playable, which is the whole point of following the change.
  assert.ok(await run(harness.controller, 'lab_new_test_game'));
  const state = await run(harness.controller, 'lab_get_state');
  assert.match(String(state.summary), /the standard opening/);
});

test('resizing the board carries a hand-made opening across rather than replacing it', async () => {
  const harness = fakeController();
  // Two rocks facing each other down one file: nothing like the default.
  await run(harness.controller, 'lab_set_starting_position', {
    rows: ['....R....', ...Array(7).fill('.........'), '....r....'],
  });
  const patched = await run(harness.controller, 'lab_patch_spec', {
    patch: { board: { width: 11, height: 9 } },
  });
  assert.deepEqual((patched.validation as { errors: unknown[] }).errors, []);
  assert.deepEqual(harness.draft.startingPosition.rows[0], '.....R.....');
  assert.deepEqual(harness.draft.startingPosition.rows[8], '.....r.....');
  assert.match(String(patched.summary), /carried across/);
});

test('replacing every kind falls back to the default opening', async () => {
  const harness = fakeController();
  const patched = await run(harness.controller, 'lab_patch_spec', {
    patch: {
      pieces: [
        { id: 'Boulder', name: 'Boulder', symbol: 'B', art: 'rock' },
        { id: 'Scroll', name: 'Scroll', symbol: 'C', art: 'paper' },
        { id: 'Shears', name: 'Shears', symbol: 'H', art: 'scissors' },
      ],
      beats: [['Boulder', 'Shears'], ['Shears', 'Scroll'], ['Scroll', 'Boulder']],
    },
  });
  assert.deepEqual((patched.validation as { errors: unknown[] }).errors, []);
  assert.deepEqual(harness.draft.startingPosition.rows[0], '...HHH...');
  assert.match(String(patched.summary), /standard one for the new shape/);
});

test('a patch that sends its own opening is left alone, even a wrong one', async () => {
  const harness = fakeController();
  const patched = await run(harness.controller, 'lab_patch_spec', {
    patch: { board: { width: 11, height: 9 }, startingPosition: { rows: ['RPS......'] } },
  });
  assert.deepEqual(harness.draft.startingPosition.rows, ['RPS......']);
  assert.ok((patched.validation as { errors: unknown[] }).errors.length > 0);
});

test('a patch that touches neither the board nor the pieces leaves the opening alone', async () => {
  const harness = fakeController();
  const custom = ['RPS......', ...Array(8).fill('.........')];
  await run(harness.controller, 'lab_set_starting_position', { rows: custom });
  await run(harness.controller, 'lab_patch_spec', { patch: { name: 'Renamed' } });
  assert.deepEqual(harness.draft.startingPosition.rows, custom);
});

test('the state tool says whether the opening is the default one', async () => {
  const harness = fakeController();
  const before = await run(harness.controller, 'lab_get_state');
  assert.match(String(before.summary), /the standard opening/);
  assert.equal((before.opening as { standard: boolean }).standard, true);

  await run(harness.controller, 'lab_set_starting_position', {
    rows: ['RPS......', ...Array(8).fill('.........')],
  });
  const after = await run(harness.controller, 'lab_get_state');
  assert.match(String(after.summary), /a custom opening/);
  assert.equal((after.opening as { standard: boolean }).standard, false);
});

/* -------------------------------------------------------------- pictures -- */

test('a picture is stored and answers with what to do with it next', async () => {
  const harness = fakeController();
  const outcome = await run(harness.controller, 'lab_add_image', {
    role: 'piece',
    url: 'https://example.com/lizard.png',
  });
  assert.equal(outcome.stored, true);
  const summary = String(outcome.summary);
  assert.match(summary, /img:/);
  // The reference and the field to put it in, so no follow-up call is needed.
  assert.match(summary, /pieces\[i\]\.art/);
  assert.equal(harness.stored.length, 1);
});

test('a guest is told to sign in, and nothing is attempted', async () => {
  const harness = fakeController({ signedIn: false });
  const outcome = await run(harness.controller, 'lab_add_image', {
    role: 'piece',
    data: 'AAAA',
  });
  assert.equal(outcome.stored, false);
  assert.equal(outcome.needsAccount, true);
  assert.equal(harness.stored.length, 0, 'a refusal should not have stored anything');
  // And it says what still works without an account, because "no" on its own
  // leaves an agent with nowhere to go.
  assert.match(String(outcome.summary), /rock/);
});

test('exactly one of a url and the bytes is required', async () => {
  const harness = fakeController();
  for (const input of [
    { role: 'piece' },
    { role: 'piece', url: 'https://example.com/a.png', data: 'AAAA' },
    { role: 'nowhere', url: 'https://example.com/a.png' },
  ]) {
    const outcome = await run(harness.controller, 'lab_add_image', input);
    assert.notEqual(outcome.stored, true, JSON.stringify(input));
  }
  assert.equal(harness.stored.length, 0);
});

test('a stored picture is referenced by id, never inlined', async () => {
  const harness = fakeController();
  const added = await run(harness.controller, 'lab_add_image', {
    role: 'piece',
    url: 'https://example.com/lizard.png',
  });
  const artId = (added.art as { artId: string }).artId;

  await run(harness.controller, 'lab_patch_spec', {
    patch: {
      pieces: TOTAL_WAR_SPEC.pieces.map((piece, index) =>
        index === 0 ? { ...piece, art: artId } : piece,
      ),
    },
  });

  const report = validateSpec(harness.draft);
  assert.deepEqual(report.errors, []);
  assert.ok(
    JSON.stringify(harness.draft).length < 16 * 1024,
    'a picture must not cost the document its budget',
  );
});

test('the pictures on an account can be listed, and say where they are used', async () => {
  const harness = fakeController();
  const empty = await run(harness.controller, 'lab_list_images');
  assert.match(String(empty.summary), /No pictures/);

  const added = await run(harness.controller, 'lab_add_image', {
    role: 'piece',
    url: 'https://example.com/a.png',
  });
  const artId = (added.art as { artId: string }).artId;
  await run(harness.controller, 'lab_patch_spec', {
    patch: {
      pieces: TOTAL_WAR_SPEC.pieces.map((piece, index) =>
        index === 0 ? { ...piece, art: artId } : piece,
      ),
    },
  });

  const listed = await run(harness.controller, 'lab_list_images');
  assert.match(String(listed.summary), new RegExp(artId));
  assert.match(String(listed.summary), /used as Rock/);
});

// The tool table in `docs/lab.md` states these two numbers in prose, so they go
// stale silently. This is what makes that a failing test instead.
test('the surface is twenty-one tools, and twenty-six once a test game exists', async () => {
  const harness = fakeController();
  assert.equal(labTools(harness.controller).length, 21);
  await run(harness.controller, 'lab_new_test_game');
  assert.equal(labTools(harness.controller).length, 26);
});

/* ------------------------------------------- working alongside a person -- */

test('lab_ask_user needs a question and at least two options', async () => {
  const harness = fakeController();

  const noQuestion = await run(harness.controller, 'lab_ask_user', {
    question: '  ',
    options: ['a', 'b'],
  });
  assert.equal(noQuestion.asked, false);

  const oneOption = await run(harness.controller, 'lab_ask_user', {
    question: 'Rock or paper?',
    options: ['rock'],
  });
  assert.equal(oneOption.asked, false);
  assert.match(String(oneOption.summary), /two options/);
});

test('lab_ask_user reports the option they pressed, by its words', async () => {
  const harness = fakeController({ answer: { id: 'option-1' } });
  const answered = await run(harness.controller, 'lab_ask_user', {
    question: 'Should the Lizard be fast?',
    options: ['Fast', 'Slow'],
  });
  assert.equal(answered.answered, true);
  assert.equal(answered.chosen, 'Slow');
  assert.match(String(answered.summary), /Slow/);
});

// The distinction that matters: a question nobody answered is not a question
// answered "no". An agent told the wrong one of those makes the wrong decision
// and never finds out.
test('a question nobody answers says so, and says what to do about it', async () => {
  const harness = fakeController({ answer: null });
  const ignored = await run(harness.controller, 'lab_ask_user', {
    question: 'Bigger board?',
    options: ['Yes', 'No'],
  });
  assert.equal(ignored.answered, false);
  assert.match(String(ignored.summary), /did not answer/);
  assert.match(String(ignored.summary), /decide it yourself/);
});

test('lab_propose_change applies only when they take it', async () => {
  const taken = fakeController({ accept: true });
  const yes = await run(taken.controller, 'lab_propose_change', {
    patch: { name: 'Leapfrog' },
    note: 'A name that says what it does.',
  });
  assert.equal(yes.applied, true);
  assert.equal(taken.draft.name, 'Leapfrog');

  const refused = fakeController({ accept: false });
  const no = await run(refused.controller, 'lab_propose_change', {
    patch: { name: 'Leapfrog' },
    note: 'A name that says what it does.',
  });
  assert.equal(no.applied, false);
  assert.match(String(no.summary), /turned it down/);
  assert.notEqual(refused.draft.name, 'Leapfrog');
});

// A refusal is an answer, not a crash — and a change that will not validate is
// the agent's mistake, not a decision to put in front of somebody.
test('a proposal that would not validate is never offered', async () => {
  const harness = fakeController({ accept: true });
  const refused = await run(harness.controller, 'lab_propose_change', {
    patch: { board: { width: 0, height: 0 } },
    note: 'Shrink it.',
  });
  assert.equal(refused.applied, false);
  assert.match(String(refused.summary), /does not validate/);
  assert.equal(harness.proposed.length, 0);
});

test('an empty patch is not offered either', async () => {
  const harness = fakeController();
  const nothing = await run(harness.controller, 'lab_propose_change', {
    patch: {},
    note: 'Nothing.',
  });
  assert.equal(nothing.applied, false);
  assert.equal(harness.proposed.length, 0);
});

test('lab_highlight takes squares, and refuses things that are not squares', async () => {
  const harness = fakeController();

  const pointing = await run(harness.controller, 'lab_highlight', {
    squares: ['d4', 'e4'],
    note: 'Where it keeps stalling.',
  });
  assert.equal(pointing.pointing, true);
  assert.deepEqual(pointing.squares, ['d4', 'e4']);

  const nonsense = await run(harness.controller, 'lab_highlight', { squares: ['d4', 'zz9plural'] });
  assert.equal(nonsense.pointing, false);
  assert.match(String(nonsense.summary), /not squares/);

  const stopped = await run(harness.controller, 'lab_highlight', {});
  assert.equal(stopped.pointing, false);
  assert.equal(harness.pointing, null);
});

test('lab_recent_activity reports the person’s work in the words of what changed', async () => {
  const harness = fakeController();
  harness.activity.push(
    {
      id: 1,
      tool: 'lab_patch_spec',
      input: {},
      summary: 'Changed board.',
      ok: true,
      atMs: 0,
      origin: 'you',
      changes: [{ label: 'board 9×9 → 7×7', kind: 'change' }],
    },
    {
      id: 2,
      tool: 'lab_simulate',
      input: {},
      summary: '40 games.',
      ok: true,
      atMs: 1,
      origin: 'lab-agent',
      changes: [],
    },
  );

  const all = await run(harness.controller, 'lab_recent_activity');
  assert.match(String(all.summary), /the person/);
  assert.match(String(all.summary), /board 9×9 → 7×7/);

  const theirs = await run(harness.controller, 'lab_recent_activity', { origin: 'you' });
  assert.equal((theirs.activity as unknown[]).length, 1);

  const nobody = await run(harness.controller, 'lab_recent_activity', { origin: 'external' });
  assert.deepEqual(nobody.activity, []);
  assert.match(String(nobody.summary), /Nothing from external/);
});

// The filter the tool advertised and did not apply. A model asking what one
// piece can do and being handed every move on the board reads it as a movement
// rule far more generous than the one it wrote.
test('lab_legal_moves honours the square it was given', async () => {
  const harness = fakeController();
  await run(harness.controller, 'lab_new_test_game');

  const everything = await run(harness.controller, 'lab_legal_moves');
  const fromOne = await run(harness.controller, 'lab_legal_moves', { from: 'a1' });
  assert.ok((everything.moves as string[]).length > (fromOne.moves as string[]).length);
  for (const move of fromOne.moves as string[]) assert.match(move, /^a1-/);

  const nonsense = await run(harness.controller, 'lab_legal_moves', { from: 'zz9' });
  assert.match(String(nonsense.summary), /Give a square/);
});
