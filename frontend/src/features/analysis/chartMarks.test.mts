// What the evaluation chart is allowed to badge.
//
// The bug this exists to prevent, measured rather than described: one archived
// 72-move game, graded by the shipped engine at the Deep rung, drew 24 badges,
// and at phone width eight of them landed inside a 61-pixel span — three and
// four deep, for a 21-pixel badge. The grades were not wrong, and the score
// sheet still shows every one of them. But a chart with a badge on a third of
// its moves is not a picture of anything, and RPSFish is far too weak for two
// dozen simultaneous confident verdicts to be a defensible thing to draw.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { MARKED_GRADES, chartMarks, markBudget } from './chartMarks';
import { MOVE_GRADES, type GradeKey } from '@/engine/gameReview';

/** One candidate, as terse as the policy needs it. */
const move = (
  index: number,
  gradeKey: GradeKey | null,
  lossPercent: number,
  extra: { isBook?: boolean } = {},
) => ({
  index,
  gradeKey,
  lossPercent,
  isBook: extra.isBook ?? false,
});

/** A chart wide enough that spacing never bites, so a test can isolate one rule. */
const wide = { x: (index: number) => index * 1_000, minimumGap: 28 };

describe('which grades the chart draws', () => {
  it('draws mistakes and blunders and nothing else', () => {
    // Stated as the full grade list rather than as two assertions, so a new
    // grade has to be classified here rather than silently joining the chart.
    const drawn = MOVE_GRADES.filter((grade) => MARKED_GRADES.has(grade.key)).map(
      (grade) => grade.key,
    );
    assert.deepEqual(drawn, ['mistake', 'blunder']);
  });

  it('leaves a great move to the score sheet', () => {
    // A compliment is not a turning point, and `great` is the badge that makes
    // the strongest claim — no other move was any good — which is the one this
    // engine can least support.
    const marks = chartMarks({
      candidates: [move(0, 'great', 0), move(1, 'best', 0), move(2, 'excellent', 1)],
      budget: 6,
      ...wide,
    });
    assert.deepEqual(marks, []);
  });

  it('ignores a move nobody made', () => {
    // A dealt opening move is evaluated so the curve has no hole in it, but
    // badging it would be a claim about a player who did not choose it.
    const marks = chartMarks({
      candidates: [move(0, 'blunder', 40, { isBook: true }), move(1, 'mistake', 12)],
      budget: 6,
      ...wide,
    });
    assert.deepEqual(
      marks.map((mark) => mark.index),
      [1],
    );
  });

  it('ignores a move the walk has not graded yet', () => {
    // A live game's report is full of these, and an ungraded move carries a
    // loss of zero — so the only thing stopping it from being ranked is that
    // it has no grade at all.
    const marks = chartMarks({
      candidates: [move(0, null, 40)],
      budget: 6,
      ...wide,
    });
    assert.deepEqual(marks, []);
  });
});

describe('the badge budget', () => {
  it('spends itself on the costliest moves', () => {
    const marks = chartMarks({
      candidates: [
        move(0, 'mistake', 11),
        move(1, 'blunder', 44),
        move(2, 'mistake', 19),
        move(3, 'blunder', 31),
        move(4, 'mistake', 13),
      ],
      budget: 2,
      ...wide,
    });
    // The two worst, and in playing order rather than in cost order: the chart
    // is a timeline, so a reader steps through it left to right.
    assert.deepEqual(
      marks.map((mark) => mark.index),
      [1, 3],
    );
  });

  it('breaks a tie on move order so the selection is not sort-dependent', () => {
    const marks = chartMarks({
      candidates: [move(7, 'mistake', 12), move(2, 'mistake', 12), move(5, 'mistake', 12)],
      budget: 2,
      ...wide,
    });
    assert.deepEqual(
      marks.map((mark) => mark.index),
      [2, 5],
    );
  });

  it('narrows on a narrow chart and never gives up entirely', () => {
    assert.equal(markBudget(1_100), 6, 'a desktop review');
    assert.equal(markBudget(360), 2, 'a phone');
    // A chart can be measured at almost nothing for a frame before layout
    // lands. Two is the floor, so the worst move of the game is never dropped
    // for want of width.
    assert.equal(markBudget(0), 2);
    assert.equal(markBudget(20_000), 6, 'and it is capped, not proportional');
  });
});

describe('badges that would overlap', () => {
  it('drops the cheaper of two mistakes drawn on top of each other', () => {
    // Four consecutive mistakes, 6 pixels apart on a 21-pixel badge: the shape
    // that made the chart unreadable. Only one can be drawn there.
    const marks = chartMarks({
      candidates: [
        move(10, 'mistake', 11),
        move(11, 'mistake', 18),
        move(12, 'mistake', 12),
        move(13, 'mistake', 14),
      ],
      x: (index) => index * 6,
      budget: 6,
      minimumGap: 28,
    });
    assert.deepEqual(
      marks.map((mark) => mark.index),
      [11],
      'the worst of the clump, and only it',
    );
  });

  it('keeps both when they are far enough apart to read', () => {
    const marks = chartMarks({
      candidates: [move(0, 'mistake', 11), move(1, 'mistake', 12)],
      x: (index) => index * 28,
      budget: 6,
      minimumGap: 28,
    });
    assert.deepEqual(
      marks.map((mark) => mark.index),
      [0, 1],
    );
  });

  it('does not let an unspent budget become a reason to overlap', () => {
    // Budget 6, two candidates, one slot's worth of room. Spare budget is not
    // permission to draw a second badge on top of the first.
    const marks = chartMarks({
      candidates: [move(0, 'blunder', 30), move(1, 'blunder', 29)],
      x: (index) => index * 4,
      budget: 6,
      minimumGap: 28,
    });
    assert.equal(marks.length, 1);
  });
});
