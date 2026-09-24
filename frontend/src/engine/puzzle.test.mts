// The rank test, against canned searches.
//
// Nothing here runs RPSFish. The rule is a function of a finished `Analysis`,
// so the cases that matter — a tie, a fold, a search that was cut off — can be
// written down exactly rather than hunted for on a real board.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createAnalysisGame, gridFromRows } from '@/engine/analysisGame';
import {
  boardSymmetries,
  certifyLine,
  certifyPosition,
  stepAccepts,
  STOP_REASON_TEXT,
  twinsOf,
  type CertifiedStep,
} from '@/engine/puzzle';
import { testMode } from '@/testing/modes';
import type { Analysis, EngineLine, StopReason } from '@/engine/rpsfish/protocol';
import type { BoardSymmetry, Move } from '@/types/game';

const rows = (...top: string[]) => [
  ...top,
  ...Array.from({ length: 9 - top.length }, () => '.........'),
];

/** d1 and f1 are each other's reflection on a nine-wide board. */
const MIRRORED = rows('...R.R...');
const LOPSIDED = rows('...R.....');

const move = (fromX: number, fromY: number, toX: number, toY: number): Move => ({
  from: { x: fromX, y: fromY },
  to: { x: toX, y: toY },
});

const D1_D2 = move(3, 0, 3, 1);
const F1_F2 = move(5, 0, 5, 1);

const line = (m: Move, score: number, rank: number): EngineLine => ({
  ...m,
  score,
  rank,
  principalVariation: [m],
});

const search = (lines: EngineLine[], stopReason: StopReason = 'depth'): Analysis => ({
  confidence: 1,
  depth: 12,
  elapsedMs: 100,
  lines,
  nodes: 1000,
  nodesPerSecond: 10_000,
  redScore: 0,
  score: lines[0]?.score ?? 0,
  selectiveDepth: 14,
  stopReason,
});

const MIRROR: BoardSymmetry[] = ['mirror-files'];

test('one move strictly ahead of the rest is a puzzle', () => {
  const result = certifyPosition(
    search([line(D1_D2, 300, 1), line(move(4, 0, 4, 1), 40, 2)]),
    gridFromRows(LOPSIDED),
    MIRROR,
  );
  assert.equal(result.certified, true);
  assert.ok(result.certified && result.step.move.from.x === 3);
});

test('two moves of equal worth are not a puzzle, and say so', () => {
  const result = certifyPosition(
    search([line(D1_D2, 300, 1), line(move(4, 0, 4, 1), 300, 2)]),
    gridFromRows(LOPSIDED),
    MIRROR,
  );
  assert.equal(result.certified, false);
  assert.equal(result.certified === false && result.stop, 'ties');
});

test('a move and its reflection are one move on a board that has the symmetry', () => {
  // The only two lines are twins, so there is nothing left to tie with.
  const result = certifyPosition(
    search([line(D1_D2, 300, 1), line(F1_F2, 300, 2)]),
    gridFromRows(MIRRORED),
    MIRROR,
  );
  assert.equal(result.certified, true, 'one idea spelled two ways still has one answer');
  assert.ok(result.certified && result.step.twins.length === 1);
});

test('the same two moves on a lopsided board are two moves, and tie', () => {
  // The mode still declares the symmetry; this *board* does not have it, so
  // folding would hide a real choice between two different ideas.
  const result = certifyPosition(
    search([line(D1_D2, 300, 1), line(F1_F2, 300, 2)]),
    gridFromRows(LOPSIDED),
    MIRROR,
  );
  assert.equal(result.certified, false);
  assert.equal(result.certified === false && result.stop, 'ties');
});

test('a board only has the symmetries it actually has', () => {
  assert.deepEqual(boardSymmetries(gridFromRows(MIRRORED), MIRROR), ['mirror-files']);
  assert.deepEqual(boardSymmetries(gridFromRows(LOPSIDED), MIRROR), []);
  assert.deepEqual(boardSymmetries(gridFromRows(MIRRORED), undefined), [], 'none declared, none used');
});

test('a search that ran out of clock has not settled on anything', () => {
  for (const reason of ['time', 'nodes', 'cancelled', 'unknown'] as const) {
    const result = certifyPosition(
      search([line(D1_D2, 300, 1), line(move(4, 0, 4, 1), 40, 2)], reason),
      gridFromRows(LOPSIDED),
      MIRROR,
    );
    assert.equal(result.certified, false, `${reason} should not certify`);
    assert.equal(result.certified === false && result.stop, 'unsettled');
  }
});

test('one line is one line asked for, not one line available', () => {
  const result = certifyPosition(search([line(D1_D2, 300, 1)]), gridFromRows(LOPSIDED), MIRROR);
  assert.equal(result.certified, false);
  assert.equal(result.certified === false && result.stop, 'unsettled');
});

test('a finished position is over rather than unanswerable', () => {
  for (const reason of ['no-legal-move', 'terminal'] as const) {
    const result = certifyPosition(search([], reason), gridFromRows(LOPSIDED), MIRROR);
    assert.equal(result.certified === false && result.stop, 'over');
  }
});

test('an absent search is unsettled rather than a crash', () => {
  assert.equal(certifyPosition(null, gridFromRows(LOPSIDED), MIRROR).certified, false);
  assert.equal(certifyPosition(undefined, gridFromRows(LOPSIDED), undefined).certified, false);
});

test('either spelling of the answer is the answer', () => {
  const step: CertifiedStep = { move: D1_D2, twins: twinsOf(D1_D2, gridFromRows(MIRRORED), MIRROR) };
  assert.ok(stepAccepts(step, D1_D2));
  assert.ok(stepAccepts(step, F1_F2), 'the reflection is the same move');
  assert.ok(!stepAccepts(step, move(4, 0, 4, 1)), 'and a third move is not');
});

// --- walking a line --------------------------------------------------------

test('a line runs while one move is best and stops saying why', async () => {
  const mode = testMode('V5');
  const start = createAnalysisGame(mode);

  // d3-d4 for Blue, then Red's forced-looking reply, then a tie.
  const blueOpens = move(3, 2, 3, 3);
  const redAnswers = move(3, 6, 3, 5);
  const blueAgain = move(4, 2, 4, 3);

  const answers: Analysis[] = [
    search([line(blueOpens, 300, 1), line(move(4, 2, 4, 3), 10, 2)]),
    search([line(redAnswers, 200, 1), line(move(4, 6, 4, 5), 10, 2)]),
    search([line(blueAgain, 300, 1), line(move(5, 2, 5, 3), 300, 2)]), // a tie
  ];
  let asked = 0;
  const searchFn = async () => answers[asked++] ?? null;

  const certified = await certifyLine({
    start,
    intended: [blueOpens, blueAgain],
    search: searchFn,
  });

  assert.equal(certified.steps.length, 1, 'one move certified before the tie');
  assert.deepEqual(certified.steps[0]?.move, blueOpens);
  assert.deepEqual(certified.replies, [redAnswers], "and the engine's defence, not the author's");
  assert.equal(certified.stop, 'ties');
  assert.equal(STOP_REASON_TEXT[certified.stop], 'more than one move is equally best here');
});

test('an author whose move is not the best one is told so', async () => {
  const mode = testMode('V5');
  const best = move(3, 2, 3, 3);
  const wrong = move(4, 2, 4, 3);
  const certified = await certifyLine({
    start: createAnalysisGame(mode),
    intended: [wrong],
    search: async () => search([line(best, 300, 1), line(wrong, 10, 2)]),
  });
  assert.equal(certified.steps.length, 0);
  assert.equal(certified.stop, 'diverged');
});

test('a line the author simply ends is not a failure', async () => {
  const mode = testMode('V5');
  const blueOpens = move(3, 2, 3, 3);
  const redAnswers = move(3, 6, 3, 5);
  const answers = [
    search([line(blueOpens, 300, 1), line(move(4, 2, 4, 3), 10, 2)]),
    search([line(redAnswers, 200, 1), line(move(4, 6, 4, 5), 10, 2)]),
    search([line(move(4, 2, 4, 3), 300, 1), line(move(5, 2, 5, 3), 10, 2)]),
  ];
  let asked = 0;
  const certified = await certifyLine({
    start: createAnalysisGame(mode),
    intended: [blueOpens],
    search: async () => answers[asked++] ?? null,
  });
  assert.equal(certified.steps.length, 1);
  assert.equal(certified.stop, 'line-end');
});
