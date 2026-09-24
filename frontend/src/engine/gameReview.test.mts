// Book plies in a review.
//
// Run with `npm run test:review`. No engine is needed: this is about what the
// report says, not about what the search finds, so the entries are supplied
// directly.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ENGINE_LOSS_ERROR_BAR,
  ENGINE_LOSS_ERROR_TAIL,
  MOVE_GRADES,
  UNCALIBRATED_MODES,
  WIN_PROBABILITY_SCALE,
  accuracyForLoss,
  formatLoss,
  reviewSourceFromPGN,
  summarizeReview,
  type GradeKey,
  type GradedMove,
  type PlayerAccuracy,
  type ReviewReport,
} from './gameReview';
import { ENGINE_MODE_CODES } from './rpsfish/protocol';
import { blunderEntry, levelEntries } from '@/testing/reviewEntries';
import { testMode } from '@/testing/modes';

const MODES = [testMode('V5')];

/** The graded form of one move, failing the test if the walk skipped it. */
const gradedMove = (report: ReviewReport, index: number): GradedMove => {
  const move = report.moves[index];
  assert.ok(move && !move.pending, `move ${index} should have been graded`);
  return move;
};

const accuracyOf = (report: ReviewReport, color: 'Red' | 'Blue'): PlayerAccuracy => {
  const accuracy = report.accuracy[color];
  assert.ok(accuracy, `${color} should have a complete accuracy`);
  return accuracy;
};

/**
 * A short Total War game whose first four plies were dealt by a series opening
 * rather than chosen by either engine.
 */
const SERIES_PGN = `[Event "Bot Match"]
[Site "RPS Strategy"]
[Date "2026.08.22"]
[Round "series-abc game-1"]
[Red "Alpha"]
[Blue "Beta"]
[Result "1-0"]
[GameId "series-game-1"]
[Variant "Total War"]
[ModeId "V5"]
[BoardSize "9"]
[TimeControl "60+0"]
[SetUp "1"]
[FEN "3SSS3/3PPP3/3RRR3/9/9/9/3rrr3/3ppp3/3sss3 r 3bbb3/3bbb3/3bbb3/9/9/9/3rrr3/3rrr3/3rrr3"]
[RedId "bot-alpha"]
[BlueId "bot-beta"]
[Ranked "true"]
[BookPlies "4"]
[OpeningSeed "4242"]
[SeriesId "abc"]
[Termination "Red wins by resignation"]
[EndReason "resignation"]
[PlyCount "6"]

1. Rd7-d6 1... Rd3-d4 2. Re7-e6 2... Re3-e4 3. Rf7-f6 3... Rf3-f4
{[%end resignation Blue]} 1-0
`;

describe('book plies', () => {
  it('reads the count out of the record', () => {
    const source = reviewSourceFromPGN(SERIES_PGN, MODES);
    assert.equal(source.bookPlies, 4);
    assert.equal(source.seriesId, 'abc');
    assert.equal(source.moves.length, 6);
  });

  it('defaults to zero for an ordinary game', () => {
    const ordinary = SERIES_PGN.replace('[BookPlies "4"]\n', '');
    assert.equal(reviewSourceFromPGN(ordinary, MODES).bookPlies, 0);
  });

  it('marks the dealt moves and leaves the chosen ones alone', () => {
    const source = reviewSourceFromPGN(SERIES_PGN, MODES);
    const report = summarizeReview({
      source,
      entries: levelEntries(source.moves.length),
      bookPlies: source.bookPlies,
    });
    assert.deepEqual(
      report.moves.map((move) => move.isBook),
      [true, true, true, true, false, false],
    );
  });

  it('keeps dealt moves out of the accuracy each engine is credited with', () => {
    const source = reviewSourceFromPGN(SERIES_PGN, MODES);
    const entries = levelEntries(source.moves.length);
    // Make the two book moves look catastrophic. Nobody chose them, so they
    // must not touch either player's accuracy — that is the whole point.
    entries[0] = blunderEntry(0);
    entries[1] = blunderEntry(1);

    const withBook = summarizeReview({ source, entries, bookPlies: 4 });
    const withoutBook = summarizeReview({ source, entries, bookPlies: 0 });

    const withBookRed = accuracyOf(withBook, 'Red');
    const withoutBookRed = accuracyOf(withoutBook, 'Red');
    assert.equal(withBookRed.moveCount, 1, 'three Red moves, two of them book');
    assert.equal(withoutBookRed.moveCount, 3);
    assert.ok(
      (withBookRed.accuracy ?? 0) > (withoutBookRed.accuracy ?? 0),
      'a blunder nobody made must not be counted against the engine',
    );
    assert.equal(withBookRed.averageLossPercent, 0);
  });

  it('still evaluates the dealt moves, so the chart has no hole in it', () => {
    const source = reviewSourceFromPGN(SERIES_PGN, MODES);
    const report = summarizeReview({
      source,
      entries: levelEntries(source.moves.length),
      bookPlies: 4,
    });
    assert.equal(report.evaluations.length, source.moves.length);
    // Graded, just not blamed: the book moves keep their evaluation.
    assert.equal(gradedMove(report, 0).pending, false);
    assert.equal(typeof gradedMove(report, 0).playedScore, 'number');
  });
});

// With the engine switched off — which is how a review now opens — nothing is
// searched, so the walk hands `summarizeReview` no entries at all. The report
// it builds from that is what a manual review renders, so it has to be a
// well-formed report rather than an empty or half-filled one.
// What the two sides were rated, which the review prints beside their names.
//
// The scale matters as much as the numbers: a record archived before the rating
// rebuild carries chess Elo centred on 1200 and names no system, and 1654 and
// 182 are both plausible ratings, so a reader with no tag to go on cannot tell
// one scale from the other. Read back verbatim here and left at that — what a
// scale's name is worth is `features/ratings/scale`'s question, not a replayed
// record's.
describe('the ratings in a record', () => {
  const RATED = SERIES_PGN.replace(
    '[Ranked "true"]',
    [
      '[RedElo "182"]',
      '[BlueElo "196"]',
      '[RedEloAfter "186"]',
      '[BlueEloAfter "192"]',
      '[RatingSystem "anchored/1"]',
      '[Ranked "true"]',
    ].join('\n'),
  );

  it('reads what each side was rated and what it moved to', () => {
    const { players } = reviewSourceFromPGN(RATED, MODES);
    assert.deepEqual(
      { elo: players.Red.elo, eloAfter: players.Red.eloAfter },
      { elo: 182, eloAfter: 186 },
    );
    assert.deepEqual(
      { elo: players.Blue.elo, eloAfter: players.Blue.eloAfter },
      { elo: 196, eloAfter: 192 },
    );
  });

  it('names the scale those numbers are on', () => {
    assert.equal(reviewSourceFromPGN(RATED, MODES).ratingSystem, 'anchored/1');
  });

  it('leaves the scale unnamed for a record from before the rebuild', () => {
    const old = RATED.replace('[RatingSystem "anchored/1"]\n', '');
    assert.equal(reviewSourceFromPGN(old, MODES).ratingSystem, null);
  });

  it('carries no rating for a record that has none', () => {
    const { players, ratingSystem } = reviewSourceFromPGN(SERIES_PGN, MODES);
    assert.equal(ratingSystem, null);
    for (const color of ['Red', 'Blue'] as const) {
      assert.equal(players[color].elo, null, `${color} should have no rating`);
      assert.equal(players[color].eloAfter, null, `${color} should have no rating after`);
    }
  });
});

describe('an ungraded review', () => {
  const ungraded = () =>
    summarizeReview({ source: reviewSourceFromPGN(SERIES_PGN, MODES), entries: [] });

  it('still lists every move that was played', () => {
    const report = ungraded();
    assert.equal(report.moves.length, 6, 'the score sheet is the point of a manual review');
    assert.ok(
      report.moves.every((move) => move.pending),
      'no move can carry a grade when nothing searched it',
    );
  });

  it('claims no accuracy for either side', () => {
    const report = ungraded();
    assert.equal(report.accuracy.Red, null);
    assert.equal(report.accuracy.Blue, null);
  });

  it('is never complete, so no number is sent to the archive', () => {
    // The review screen stores an accuracy only from a complete report. A
    // manual review that reported itself complete would overwrite a real
    // number measured by an earlier graded one.
    assert.equal(ungraded().complete, false);
    assert.equal(ungraded().analyzed, 0);
  });

  it('has no evaluation curve to draw', () => {
    assert.deepEqual(ungraded().evaluations, []);
  });
});

describe('the grade bands', () => {
  // The bands are the whole of what a badge means, and the thing that goes
  // wrong with them is silent: narrow one and it keeps working, keeps
  // type-checking, and starts sorting the engine's noise into confident
  // verdicts. So the rule they were set by is asserted rather than left in a
  // comment.
  const bands = MOVE_GRADES.filter(
    (grade) => grade.key !== 'best' && grade.key !== 'great',
  );

  it("never draws a boundary inside the engine's own error bar", () => {
    let floor = 0;
    for (const band of bands) {
      if (band.maxLoss === Infinity) break;
      const width = band.maxLoss - floor;
      assert.ok(
        width >= ENGINE_LOSS_ERROR_BAR,
        `${band.key} spans ${width} points, inside the engine's ${ENGINE_LOSS_ERROR_BAR}-point ` +
          'disagreement with itself — it would sort noise rather than moves',
      );
      floor = band.maxLoss;
    }
  });

  it('cuts the accuracy scale into fifths', () => {
    // The point of deriving the bands rather than picking them: a grade can be
    // stated without looking anything up. Excellent scored 80% or better on
    // the same curve the review reports, Good 60 to 80, and so on.
    const scored = Object.fromEntries(
      bands
        .filter((band) => band.maxLoss !== Infinity)
        .map((band) => [band.key, Math.round(accuracyForLoss(band.maxLoss))]),
    );
    assert.deepEqual(scored, { excellent: 80, good: 61, inaccuracy: 40, mistake: 20 });
  });

  it('puts the accusing bands outside the tail, not just outside the error bar', () => {
    // The distinction this encodes: Excellent and Good describe a move, while
    // Mistake and Blunder accuse somebody of one. A description that is one
    // class out is a wrong word; an accusation that is one class out is the
    // review telling a player they threw a game away when they did not. So
    // the two accusing bands have to clear the *tail* of the engine's
    // disagreement with itself, not its typical value.
    const floorOf = (key: GradeKey) => {
      const at = bands.findIndex((band) => band.key === key);
      assert.ok(at > 0, `${key} needs a band below it to have a floor`);
      return bands[at - 1]?.maxLoss ?? 0;
    };
    for (const key of ['mistake', 'blunder'] as const) {
      const floor = floorOf(key);
      assert.ok(
        floor >= ENGINE_LOSS_ERROR_TAIL * 1.5,
        `${key} starts at ${floor}, inside 1.5x the engine's ${ENGINE_LOSS_ERROR_TAIL}-point ` +
          'tail — a badge this confident needs more margin than that',
      );
    }
  });

  it('rises, and ends open', () => {
    const ceilings = bands.map((band) => band.maxLoss);
    assert.deepEqual(
      ceilings,
      [...ceilings].sort((left, right) => left - right),
      'the bands are searched in order, so an out-of-order ceiling is unreachable',
    );
    assert.equal(ceilings[ceilings.length - 1], Infinity, 'every loss has a grade');
  });
});

describe('the win-probability scale', () => {
  it('has a fitted value for every mode the engine will search', () => {
    // The gap this closes: `scaleFor` falls back to another mode's logistic
    // without a word, so a mode added to the engine starts grading games
    // through a curve fitted for a different one. Intransitive did that for
    // its whole life so far, and it is the mode nearly every game on the site
    // is played in. A new mode now has to be fitted or admitted to.
    const unaccounted = Object.keys(ENGINE_MODE_CODES).filter(
      (modeId) =>
        WIN_PROBABILITY_SCALE[modeId as keyof typeof WIN_PROBABILITY_SCALE] ===
          undefined && !UNCALIBRATED_MODES.has(modeId),
    );
    assert.deepEqual(
      unaccounted,
      [],
      'run `npm run calibrate:review -- --mode <id>` and put the fitted value in ' +
        'WIN_PROBABILITY_SCALE, or add the mode to UNCALIBRATED_MODES with a reason',
    );
  });

  it('does not keep a mode on the uncalibrated list once it is fitted', () => {
    // Otherwise the list rots into a lie about what has been measured.
    const both = [...UNCALIBRATED_MODES].filter(
      (modeId) =>
        WIN_PROBABILITY_SCALE[modeId as keyof typeof WIN_PROBABILITY_SCALE] !== undefined,
    );
    assert.deepEqual(both, [], 'these modes are fitted, so remove them from UNCALIBRATED_MODES');
  });
});

describe('a loss, as a sentence', () => {
  it('does not print a precision the engine cannot support', () => {
    // "10.1 points" invites a reader to compare two moves the engine cannot
    // separate: its own opinion of the same move moves by more than that
    // between depths.
    assert.equal(formatLoss(10.1), '10 points');
    assert.equal(formatLoss(19.6), '20 points');
  });

  it('says a small loss is nothing rather than quantifying it', () => {
    assert.equal(formatLoss(0.4), 'under a point');
    assert.equal(formatLoss(0), 'under a point');
    assert.equal(formatLoss(Number.NaN), 'under a point');
  });
});
