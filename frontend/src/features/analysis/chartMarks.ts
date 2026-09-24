// Which moves the evaluation chart puts a badge on.
//
// Separate from the chart because it is a policy rather than a drawing: the
// question "which of this game's mistakes are worth naming on one small
// picture" has a right answer that does not depend on React, and it is the
// answer that went wrong. The chart used to badge every `great`, `mistake` and
// `blunder`. Measured on one archived 72-move game, graded by the shipped
// engine at the Deep rung, that rule drew **24 badges** — and at phone width
// eight of them landed inside a 61-pixel span, which for a 21-pixel badge
// means three and four deep. The same game now draws five.
//
// Two rules, both about what a chart is for rather than how much room it has:
//
//   1. **Errors only.** A compliment is not a turning point, and the chart is
//      the shape of the game. `great` in particular makes the strongest claim
//      any badge makes — that no other move in the position was any good —
//      which is the claim RPSFish is least able to support, so it is the last
//      one worth printing in two places. Every grade is still on every move in
//      the score sheet.
//   2. **A budget, spent worst-first.** However long a game is, the moments
//      that decided it are a handful. The badges go to the costliest moves
//      that fit without touching, and the rest are read in the list.
//
// Both rules exist because the engine is weak (`docs/review.md`, "The engine is
// off unless you ask for it"). A wrong badge is worse than a missing one, so a
// screen that can only show a few should show the few it is most sure of —
// which, loss being the only evidence it has, means the largest.

import type { GradeKey } from '@/engine/gameReview';

/** The grades the chart will draw. */
export const MARKED_GRADES: ReadonlySet<GradeKey> = new Set<GradeKey>(['mistake', 'blunder']);

/**
 * How many badges a chart this wide can carry and still be a chart.
 *
 * Deliberately far below what would physically fit — thirty would, at desktop
 * width. This is an editorial limit; `minimumGap` below is the collision one,
 * and they are separate because a chart that is merely non-overlapping is
 * still not a picture of anything.
 */
export const markBudget = (width: number) =>
  Math.max(2, Math.min(6, Math.round(width / 150)));

/**
 * The least a mark needs to know about a move.
 *
 * `gradeKey` is `null` for a move the walk has not graded yet — one value for
 * "no verdict", rather than a flag beside a grade that has to be some
 * arbitrary key while it means nothing.
 */
export interface MarkCandidate {
  index: number;
  gradeKey: GradeKey | null;
  lossPercent: number;
  /** Dealt from the opening book, so nobody chose it. */
  isBook: boolean;
}

/**
 * The moves to badge, in the order they were played.
 *
 * `x` places a move index on the chart, so the spacing rule is in the same
 * units the badges are drawn in rather than in plies — two mistakes four moves
 * apart overlap on a phone and not on a desktop, and the rule has to know that.
 */
export const chartMarks = <TCandidate extends MarkCandidate>({
  candidates,
  x,
  budget,
  minimumGap,
}: {
  candidates: readonly TCandidate[];
  x: (index: number) => number;
  budget: number;
  minimumGap: number;
}): TCandidate[] => {
  // Worst first, so the budget goes to the moves that cost the most and a
  // cheap error never crowds out an expensive one. `index` breaks ties, so the
  // selection does not depend on the sort being stable.
  const ranked = candidates
    .filter(
      (candidate) =>
        candidate.gradeKey !== null &&
        !candidate.isBook &&
        MARKED_GRADES.has(candidate.gradeKey),
    )
    .slice()
    .sort(
      (left, right) => right.lossPercent - left.lossPercent || left.index - right.index,
    );

  // Take the worst that still clears everything already taken. An overlapped
  // badge is worse than an absent one: it hides one verdict and misreads the
  // one drawn on top of it.
  const taken: TCandidate[] = [];
  for (const candidate of ranked) {
    if (taken.length >= budget) break;
    const clear = taken.every(
      (other) => Math.abs(x(other.index) - x(candidate.index)) >= minimumGap,
    );
    if (clear) taken.push(candidate);
  }
  return taken.sort((left, right) => left.index - right.index);
};
