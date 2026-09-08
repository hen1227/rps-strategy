// Book plies in a review.
//
// Run with `npm run test:review`. No engine is needed: this is about what the
// report says, not about what the search finds, so the entries are supplied
// directly.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  reviewSourceFromPGN,
  summarizeReview,
  type GradedMove,
  type PlayerAccuracy,
  type ReviewReport,
} from './gameReview';
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
