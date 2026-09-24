// Reading a record written before the 2026-09-03 board flip.
//
// The board was flipped end for end that day and the colours renamed, so
// Intransitive's goal corners moved: Red's from i1 to a1 and Blue's from a9 to
// i9. Movement and capture know nothing about colour, so every move in an old
// record is still legal today and the archive replays right up to the moment
// somebody wins — which is the one thing that reads differently, and the reason
// this is worth a test of its own rather than a line in the review's.
//
// The fixture is a real archived game, not one built with the transform under
// test. That distinction has already cost this project once: a fixture
// fabricated by a relabelling and read back by the same relabelling agrees with
// itself no matter which relabelling it is. This is game
// 935ed6b01f79b9e22e309ce5 as production stores it, with only the clock
// comments removed; it is the same record the backend pins against in
// `internal/server/testdata/prechange_v6.pgn`.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { goalOwnerAt } from './goals';
import { reviewSourceFromPGN } from './gameReview';
import { testMode } from '@/testing/modes';
import type { SideColor } from '@/types/game';

const SHAPE = { columns: 9, rows: 9 };
const MODES = [testMode('V6'), testMode('V3'), testMode('V5')];

/** Every tile some side wins by standing on in one era, as `x,y` keys. */
const goalTiles = (modeId: string, era: 'current' | 'preChange'): Map<string, SideColor> => {
  const found = new Map<string, SideColor>();
  for (let y = 0; y < SHAPE.rows; y += 1) {
    for (let x = 0; x < SHAPE.columns; x += 1) {
      const owner = goalOwnerAt(modeId, x, y, SHAPE, era);
      if (owner) found.set(`${x},${y}`, owner);
    }
  }
  return found;
};

/**
 * Game 935ed6b01f79b9e22e309ce5: a ranked Intransitive game from 2026-09-02,
 * the day before the flip. Red opens — which no game does now — and wins on i1,
 * which is not a goal square under today's rules at all.
 */
const PRE_CHANGE_V6_PGN = `[Event "Ranked"]
[Site "RPS Strategy"]
[Date "2026.09.02"]
[Round "-"]
[Red "itzsushii"]
[Blue "Henhen1227"]
[Result "1-0"]
[GameId "935ed6b01f79b9e22e309ce5"]
[Variant "Intransitive"]
[ModeId "V6"]
[BoardSize "9"]
[TimeControl "300+3"]
[SetUp "1"]
[FEN "9/4PR3/4SPR2/5SPR1/1ps3SP1/1rps5/2rps4/3rp4/9 r 9/4bb3/4bbb2/5bbb1/1rr3bb1/1rrr5/2rrr4/3rr4/9"]
[Termination "Red wins by corner"]
[EndReason "corner"]
[PlyCount "47"]
[Generator "rps-strategy-pgn/1"]

1. Sd6-e5 1... Sf4-e4 2. Rc7-d6 2... Rg3-f4 3. Pd7-e6 3... Sg5-f6 4. Pc6-d5
4... Se3-d4 5. Rd8-d7 5... Se4xd5 6. Rd6xd5 6... Rf4xe5 7. Pe6xe5 7... Sd4xe5
8. Rd5xe5 8... Pg4-f5 9. Re5xf6 9... Pf5xf6 10. Se7xf6 10... Rh4-g5 11. Pe8-f7
11... Rg5xf6 12. Pf7xf6 12... Ph5-g6 13. Pb5-a6 13... Rf2-e3 14. Pf6-e5
14... Pg6-f7 15. Pa6-a7 15... Pf7-e8 16. Sc5-c6 16... Re3-d3 17. Pe5-d4
17... Rd3-d2 18. Pd4-d3 18... Rd2-e1 19. Pd3-e3 19... Pe8-d8 20. Pa7-b7
20... Pf3-e4 21. Pe3-f2 21... Pe2-f1 22. Pf2-g1 22... Pf1-g2 23. Pg1-h1
23... Pg2-h2 24. Ph1-i1# {[%end corner Red]} 1-0
`;

/**
 * Game fd5ce93b7e4b2ac35ddc7790: the same mode six days later, under today's
 * rules. Blue opens and Red wins on a1 — the corner that was Blue's own home in
 * the record above — so the pair between them pins both ends of the flip.
 */
const CURRENT_V6_PGN = `[Event "Casual"]
[Site "RPS Strategy"]
[Date "2026.09.08"]
[Round "-"]
[Red "NewLeyattra"]
[Blue "AstraKorrin"]
[Result "1-0"]
[GameId "fd5ce93b7e4b2ac35ddc7790"]
[Variant "Intransitive"]
[ModeId "V6"]
[BoardSize "9"]
[TimeControl "300+3"]
[SetUp "1"]
[FEN "9/3RP4/2RPS4/1RPS5/1PS3sp1/5spr1/4spr2/4pr3/9 b 9/3bb4/2bbb4/1bbb5/1bb3rr1/5rrr1/4rrr2/4rr3/9"]
[Termination "Red wins by corner"]
[EndReason "corner"]
[PlyCount "14"]
[Generator "rps-strategy-pgn/2"]

1. Se3-f4 1... Pg6-f5 2. Rd2-c1 2... Pf5-e4 3. Rc1-b1 3... Pe4-e3 4. Rb1-a1
4... Pe3-d2 5. Ra1-a2 5... Pd2-c2 6. Ra2-b1 6... Pc2-b2 7. Rb1-a1
7... Pb2xa1# {[%end corner Red]} 1-0
`;

/**
 * Today's opening board, handed to Red: a position somebody set up, not a
 * record from before the flip. One Red move, so it replays.
 */
const RED_TO_MOVE_FROM_TODAYS_OPENING = `[Event "Casual"]
[Site "RPS Strategy"]
[Red "Drawn"]
[Blue "Board"]
[Result "*"]
[GameId "set-up-for-red"]
[Variant "Intransitive"]
[ModeId "V6"]
[BoardSize "9"]
[SetUp "1"]
[FEN "9/3RP4/2RPS4/1RPS5/1PS3sp1/5spr1/4spr2/4pr3/9 r 9/3bb4/2bbb4/1bbb5/1bb3rr1/5rrr1/4rrr2/4rr3/9"]
[Generator "rps-strategy-pgn/2"]

1. Pe8-d8 *
`;

describe('goalOwnerAt across the board flip', () => {
  it('moves Intransitive\'s corners to the ones the old rules used', () => {
    assert.deepEqual(
      [...goalTiles('V6', 'preChange')].sort(),
      [
        ['0,8', 'Blue'],
        ['8,0', 'Red'],
      ],
    );
  });

  it('leaves Infiltration alone, because its goal ranks are each other\'s images', () => {
    assert.deepEqual(
      [...goalTiles('V3', 'preChange')].sort(),
      [...goalTiles('V3', 'current')].sort(),
    );
  });

  it('gives Total War no goal in either era', () => {
    assert.equal(goalTiles('V5', 'preChange').size, 0);
    assert.equal(goalTiles('V5', 'current').size, 0);
  });
});

describe('reviewSourceFromPGN on a pre-change record', () => {
  it('replays a real archived game to the corner it was actually won on', () => {
    const source = reviewSourceFromPGN(PRE_CHANGE_V6_PGN, MODES);

    assert.equal(source.era, 'preChange');
    assert.equal(source.moves.length, 47, 'every move in the record should replay');

    const final = source.positions[source.positions.length - 1];
    assert.equal(final.status, 'Finished');
    assert.equal(final.winner, 'Red');
    assert.equal(final.endReason, 'corner');
  });

  it('ends the game on the winning move and not before it', () => {
    const source = reviewSourceFromPGN(PRE_CHANGE_V6_PGN, MODES);
    const unfinished = source.positions
      .slice(0, -1)
      .filter((position) => position.status !== 'InProgress');

    // Today's corners are a1 and i9, and both are squares this game walks
    // through. Judged by them it ends several moves early, which is what turned
    // a readable record into "move 9 is not legal" on the review screen.
    assert.deepEqual(unfinished, [], 'no position before the last should be finished');
  });

  it('reads the era off the board, so a game that opens with Red today is not turned', () => {
    // Red to move is the loudest signal a pre-change record gives, and on its
    // own it is not enough: this is today's opening board handed to Red, which
    // is a position somebody set up rather than a game from before the flip.
    // Judging it by yesterday's corners would break a record that reads
    // correctly today, so the board has to agree before the era moves.
    assert.equal(reviewSourceFromPGN(RED_TO_MOVE_FROM_TODAYS_OPENING, MODES).era, 'current');
  });

  it('leaves a record from today alone', () => {
    const source = reviewSourceFromPGN(CURRENT_V6_PGN, MODES);

    assert.equal(source.era, 'current');
    assert.equal(source.moves.length, 14);

    const final = source.positions[source.positions.length - 1];
    assert.equal(final.status, 'Finished');
    assert.equal(final.winner, 'Red');
    assert.equal(final.endReason, 'corner');
  });
});
