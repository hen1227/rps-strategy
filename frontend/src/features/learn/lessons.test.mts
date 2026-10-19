import assert from 'node:assert/strict';
import test from 'node:test';

import { allValidMoves, applyAnalysisMove, squareLabel } from '@/engine/analysisGame';
import { judgeSolveMove, reachableBy, solveGame } from '@/engine/puzzleSolve';
import { testMode } from '@/testing/modes';
import { LESSON_MODE_ID, LESSONS, square, type Lesson } from './lessons.ts';

const mode = testMode(LESSON_MODE_ID);

const spelled = ({ from, to }: { from: { x: number; y: number }; to: { x: number; y: number } }) =>
  `${squareLabel(from)}-${squareLabel(to)}`;

/** Every legal move in a lesson, judged, keyed by its spelling. */
const judgeAll = (lesson: Lesson) => {
  const game = solveGame(mode, lesson);
  return allValidMoves(game).map((candidate) => {
    const judged = judgeSolveMove(lesson, game, candidate.from, candidate.to);
    assert.ok(judged, `${spelled(candidate)} is legal, so it is judged`);
    return { move: spelled(candidate), ...judged };
  });
};

const answersOf = (lesson: Lesson) =>
  judgeAll(lesson)
    .filter((entry) => entry.verdict === 'solved')
    .map((entry) => entry.move)
    .sort();

const lesson = (id: string) => {
  const found = LESSONS.find((candidate) => candidate.id === id);
  assert.ok(found, `there is a lesson called ${id}`);
  return found;
};

test('every lesson opens with Blue to move on an unfinished board', () => {
  for (const each of LESSONS) {
    const game = solveGame(mode, each);
    assert.equal(game.currentTurn, 'Blue', each.id);
    assert.equal(game.status, 'InProgress', each.id);
    assert.ok(allValidMoves(game).length > 1, `${each.id} offers a choice`);
  }
});

// The sets below are the whole of each lesson's answer. Written out move by
// move rather than counted, so a change to a position or to the rules that
// opens a second answer, or closes the only one, fails here by name.

test('the capture lesson is answered by the rock taking the scissors and nothing else', () => {
  assert.deepEqual(answersOf(lesson('capture')), ['d4-e5']);
});

test('the run lesson is answered by the two squares no scissors touches', () => {
  assert.deepEqual(answersOf(lesson('run')), ['e4-e3', 'e4-f3']);
});

test('the run lesson washes exactly the squares a scissors could take the paper on', () => {
  const run = lesson('run');
  assert.equal(run.danger, 'Paper');
  // Every wrong step lands in the wash, and neither answer does: the orange
  // squares are the whole of the lesson, so they must agree with it.
  for (const entry of judgeAll(run)) {
    const to = square(entry.move.slice(3));
    assert.equal(
      reachableBy(solveGame(mode, run).grid, to, 'Red'),
      entry.verdict === 'wrong',
      entry.move,
    );
  }
});

test('the corner lesson is won by the paper and only the paper', () => {
  assert.deepEqual(answersOf(lesson('corner')), ['h8-i9']);
  const win = judgeAll(lesson('corner')).find((entry) => entry.move === 'h8-i9');
  assert.equal(win?.applied.game.winner, 'Blue');
  assert.equal(win?.applied.game.endReason, 'corner');
});

test('the guard lesson is answered by paper blocking paper', () => {
  assert.deepEqual(answersOf(lesson('guard')), ['b1-a1']);
});

test('the rock on the corner is legal and wrong, because paper takes it', () => {
  const rock = judgeAll(lesson('guard')).find((entry) => entry.move === 'a2-a1');
  assert.ok(rock, 'the rock may step onto the corner');
  assert.equal(rock.verdict, 'wrong');
});

test('no wrong answer ends the game', () => {
  // A wrong move is shown and taken back. If one finished the game — a corner
  // reached, or the other side left with no move, which loses in this mode —
  // the board would be showing a result the lesson never explains.
  for (const each of LESSONS) {
    for (const entry of judgeAll(each)) {
      if (entry.verdict === 'solved') continue;
      assert.equal(entry.applied.game.status, 'InProgress', `${each.id}: ${entry.move}`);
    }
  }
});

test('every wrong step in the run lesson is answered by a scissors taking the paper', () => {
  const run = lesson('run');
  for (const entry of judgeAll(run)) {
    if (entry.verdict === 'solved') continue;
    const played = { from: square(entry.move.slice(0, 2)), to: square(entry.move.slice(3)) };
    const reply = run.refute?.(played, entry.applied.game);
    assert.ok(reply, `${entry.move} has a reply`);
    const answered = applyAnalysisMove(entry.applied.game, reply.from, reply.to);
    assert.ok(answered, `${entry.move}: the reply is legal`);
    assert.equal(answered.captured, true, `${entry.move}: the reply takes the paper`);
    assert.equal(entry.applied.game.grid[reply.from.y]?.[reply.from.x]?.occupant, 'Scissors');
  }
});

test('every wrong answer in the guard lesson is answered by their paper taking the corner', () => {
  const guard = lesson('guard');
  for (const entry of judgeAll(guard)) {
    if (entry.verdict === 'solved') continue;
    const played = { from: square(entry.move.slice(0, 2)), to: square(entry.move.slice(3)) };
    const reply = guard.refute?.(played, entry.applied.game);
    assert.ok(reply, `${entry.move} has a reply`);
    const answered = applyAnalysisMove(entry.applied.game, reply.from, reply.to);
    assert.equal(answered?.game.winner, 'Red', entry.move);
    assert.equal(answered?.game.endReason, 'corner', entry.move);
  }
});

test('only the corner lesson is answered by ending the game', () => {
  // The other three carry on after the answer. Ending them would mean a
  // result card's worth of meaning nobody was asked to learn yet.
  for (const each of LESSONS) {
    for (const entry of judgeAll(each)) {
      if (entry.verdict !== 'solved') continue;
      assert.equal(
        entry.applied.game.status === 'Finished',
        each.id === 'corner',
        `${each.id}: ${entry.move}`,
      );
    }
  }
});

test('a move the rules refuse is not an answer of any kind', () => {
  const capture = lesson('capture');
  const game = solveGame(mode, capture);
  // Rock onto paper: the one neighbour the rock may not enter.
  assert.equal(judgeSolveMove(capture, game, square('d4'), square('c5')), null);
  // Two squares at once.
  assert.equal(judgeSolveMove(capture, game, square('d4'), square('d6')), null);
});

test('squares are named the way the board labels them', () => {
  assert.deepEqual(square('a1'), { x: 0, y: 0 });
  assert.deepEqual(square('i9'), { x: 8, y: 8 });
  assert.equal(squareLabel(square('e4')), 'e4');
});
