// The playtester, checked on modes whose problems are known in advance.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { INFILTRATION_SPEC, TOTAL_WAR_SPEC } from '@/engine/spec/builtin';
import { CORPUS_SPECS } from '@/engine/spec/conformance/specs';
import { createSpecAnalyze } from '@/engine/spec/specSearch';
import { simulate } from '@/engine/spec/simulate';
import { createAnalysisGame, allValidMoves } from '@/engine/analysisGame';
import { modeDefinitionFor } from '@/engine/spec/interpret';
import { SPEC_VERSION, type RuleSpec } from '@/engine/spec/types';

test('a shipped mode looks like a game: both sides win and rules fire', () => {
  const report = simulate(INFILTRATION_SPEC, { games: 20, plyLimit: 200, seed: 3 });
  assert.equal(report.games, 20);
  assert.ok(report.redWins + report.blueWins + report.draws > 0);
  assert.deepEqual(report.winConditionsNeverFired, [], report.notes.join(' | '));
  assert.deepEqual(report.movementRulesNeverUsed, []);
  assert.deepEqual(report.piecesThatNeverMoved, []);
});

test('the same seed gives the same answer twice', () => {
  const first = simulate(TOTAL_WAR_SPEC, { games: 8, plyLimit: 80, seed: 11 });
  const second = simulate(TOTAL_WAR_SPEC, { games: 8, plyLimit: 80, seed: 11 });
  assert.equal(first.redWins, second.redWins);
  assert.equal(first.averagePlies, second.averagePlies);
  assert.deepEqual(first.endings, second.endings);
});

test('a win condition nobody can satisfy is named', () => {
  // Reaching a rank that is not on the board's own side to reach: Red starts on
  // the last rank, so "land on your own home" can only fire for a piece that
  // never left, which never happens.
  const unreachable: RuleSpec = {
    ...INFILTRATION_SPEC,
    win: [
      { id: 'impossible', when: { gt: [{ count: { owner: 'mover' } }, 999] }, result: 'mover' },
    ],
  };
  const report = simulate(unreachable, { games: 6, plyLimit: 60, seed: 2 });
  assert.deepEqual(report.winConditionsNeverFired, ['impossible']);
  assert.ok(report.notes.some((note) => note.includes('impossible')));
});

test('a movement rule that can never apply is named', () => {
  const withDeadRule: RuleSpec = {
    ...TOTAL_WAR_SPEC,
    movement: [
      { kind: 'step', dirs: 'all8', distance: 1 },
      // Nothing is ever adjacent-then-empty-beyond in the first few plies of a
      // packed opening... but more to the point, no piece is declared for it.
      { kind: 'leap', dirs: { offsets: [[0, 8]] }, piece: 'Rock' },
    ],
  };
  const report = simulate(withDeadRule, { games: 4, plyLimit: 20, seed: 5 });
  assert.ok(
    report.movementRulesNeverUsed.some((name) => name.includes('leap')),
    report.movementRulesNeverUsed.join(' | '),
  );
});

test('a piece that cannot move is named', () => {
  const withStatue: RuleSpec = {
    ...TOTAL_WAR_SPEC,
    pieces: [...TOTAL_WAR_SPEC.pieces, { id: 'Statue', name: 'Statue', symbol: 'T' }],
    startingPosition: {
      rows: TOTAL_WAR_SPEC.startingPosition.rows.map((row, y) =>
        y === 4 ? 'T...T...T' : row,
      ),
    },
    movement: [{ kind: 'step', dirs: 'all8', distance: 1, piece: ['Rock', 'Paper', 'Scissors'] }],
  };
  const report = simulate(withStatue, { games: 4, plyLimit: 40, seed: 7 });
  assert.deepEqual(report.piecesThatNeverMoved, ['Statue']);
  assert.ok(report.notes.some((note) => note.includes('Statue')));
});

test('a mode nobody can win is called out', () => {
  const stalemateOnly: RuleSpec = {
    spec: SPEC_VERSION,
    name: 'Shuffle',
    shortCode: 'SHF',
    description: 'Nothing ever happens.',
    objective: 'Nothing.',
    board: { width: 4, height: 4 },
    pieces: [{ id: 'Stone', name: 'Stone', symbol: 'T' }],
    beats: [],
    capture: { mode: 'never' },
    startingPosition: { rows: ['T...', '....', '....', '...t'] },
    movement: [{ kind: 'step', dirs: 'orthogonal', distance: 1 }],
    win: [],
    draw: { moveLimit: 30 },
  };
  const report = simulate(stalemateOnly, { games: 4, plyLimit: 60, seed: 1 });
  assert.equal(report.redWins + report.blueWins, 0);
  assert.ok(report.notes.some((note) => note.includes('Nobody ever won')));
});

test('playing better changes the outcome, which is the point of the strength dial', () => {
  const random = simulate(CORPUS_SPECS.menagerie!, { games: 12, plyLimit: 120, seed: 4, strength: 0 });
  const trying = simulate(CORPUS_SPECS.menagerie!, { games: 12, plyLimit: 120, seed: 4, strength: 1 });
  // Not asserting which is higher — that is a fact about the mode, not about the
  // simulator. Only that the dial does something, so an author asking "does this
  // hold up when both sides try" gets a different answer from "can it be
  // finished at all".
  assert.notDeepEqual(
    [random.redWins, random.blueWins, random.averagePlies],
    [trying.redWins, trying.blueWins, trying.averagePlies],
  );
});

test('the search finds a win it can see, on a mode it has never met', () => {
  const spec = CORPUS_SPECS.longReach!;
  const analyze = createSpecAnalyze(spec, { maxDepth: 3, maxTimeMs: 2_000 });
  const mode = modeDefinitionFor(spec, 'search-test');
  // Red's rook on a5 is one slide from Blue's home rank, which wins outright.
  const game = createAnalysisGame(mode, {
    rows: ['........', '........', '........', '........', 'r......R'],
  });
  assert.ok(allValidMoves(game).length > 0);
  return analyze(
    { grid: game.grid, currentTurn: 'Red', modeId: mode.id, moveNumber: 0 },
    { maxDepth: 3, maxTimeMs: 2_000, maxNodes: 200_000, throttleMs: 0, variations: 3 },
  ).then((analysis) => {
    assert.ok(analysis.lines.length > 0, 'the search returned no lines');
    const best = analysis.lines[0]!;
    assert.equal(best.to.y, 0, `expected a move onto rank 1, got ${JSON.stringify(best)}`);
    assert.ok(analysis.score > 1000, `a forced win should score high, got ${analysis.score}`);
    assert.ok(analysis.nodes > 0);
  });
});
