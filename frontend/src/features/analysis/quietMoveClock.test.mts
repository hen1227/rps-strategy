// What the hundred-move meter says about a position, and when it says nothing.
//
// The rule itself is checked in `engine/drawRules.test.mts`, against the engine
// that adjudicates it. This is the reading of that rule: a countdown that is
// out by a move, or that reaches zero while the game is still being played,
// tells a player they have time they do not have.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  QUIET_MOVES_BEFORE_SHOWING,
  QUIET_MOVE_LIMIT,
  quietMoveClock,
} from './quietMoveClock';
import { QUIET_PLY_LIMIT } from '@/engine/modeRules';
import type { GameStatus } from '@/types/game';

/** The two fields of a position this reads, as a position to read. */
const at = (quietPlies: number, status: GameStatus = 'InProgress') => ({
  quietPlies,
  status,
});

describe('the hundred-move meter', () => {
  it('says nothing about a game nobody is shuffling in', () => {
    assert.equal(quietMoveClock(null), null);
    assert.equal(quietMoveClock(undefined), null);
    assert.equal(quietMoveClock(at(0)), null);
    // One ply short of the twentieth move. A meter that appeared here would be
    // counting down to a draw during an ordinary opening.
    assert.equal(quietMoveClock(at(QUIET_MOVES_BEFORE_SHOWING * 2 - 1)), null);
  });

  it('appears on the twentieth quiet move', () => {
    const clock = quietMoveClock(at(QUIET_MOVES_BEFORE_SHOWING * 2));
    assert.equal(clock?.movesPlayed, QUIET_MOVES_BEFORE_SHOWING);
    assert.equal(clock?.movesLeft, QUIET_MOVE_LIMIT - QUIET_MOVES_BEFORE_SHOWING);
    assert.equal(clock?.urgency, 'counting');
  });

  // The game is over: the result card says how it ended, and a meter beside it
  // would be describing a game that is not being played any more. True of the
  // draw this rule itself declares, which is the position with the fullest
  // meter of all.
  it('says nothing about a game that has finished', () => {
    assert.equal(quietMoveClock(at(QUIET_PLY_LIMIT / 2, 'Finished')), null);
    assert.equal(quietMoveClock(at(QUIET_PLY_LIMIT, 'Finished')), null);
  });

  it('counts moves the way the rule is spoken about', () => {
    assert.equal(QUIET_MOVE_LIMIT * 2, QUIET_PLY_LIMIT);
    // Blue's step is the ply that opens a move and Red's closes it, so a move
    // is only played once both have taken it.
    assert.equal(quietMoveClock(at(80))?.movesPlayed, 40);
    assert.equal(quietMoveClock(at(81))?.movesPlayed, 40);
    assert.equal(quietMoveClock(at(82))?.movesPlayed, 41);
  });

  it('never promises a move that is not there', () => {
    for (let plies = QUIET_MOVES_BEFORE_SHOWING * 2; plies < QUIET_PLY_LIMIT; plies += 1) {
      const clock = quietMoveClock(at(plies));
      assert.ok(clock, `no meter at ${plies} quiet plies`);
      // What "draw in N moves" claims: N more from each side, at most.
      assert.equal(clock.movesLeft, Math.ceil((QUIET_PLY_LIMIT - plies) / 2));
      assert.ok(clock.movesLeft >= 1, `counted down to ${clock.movesLeft} while still in play`);
      assert.equal(clock.movesPlayed + clock.movesLeft, QUIET_MOVE_LIMIT);
      assert.ok(clock.progress > 0 && clock.progress < 1);
    }
  });

  it('warns before it counts down', () => {
    // Halfway: the draw stops being a curiosity.
    assert.equal(quietMoveClock(at(QUIET_PLY_LIMIT / 2 - 2))?.urgency, 'counting');
    assert.equal(quietMoveClock(at(QUIET_PLY_LIMIT / 2))?.urgency, 'closing');
    // Ten moves out, with a capture still able to reset the whole thing.
    assert.equal(quietMoveClock(at(QUIET_PLY_LIMIT - 22))?.urgency, 'closing');
    assert.equal(quietMoveClock(at(QUIET_PLY_LIMIT - 20))?.urgency, 'imminent');
    const last = quietMoveClock(at(QUIET_PLY_LIMIT - 1));
    assert.equal(last?.urgency, 'imminent');
    assert.equal(last?.movesLeft, 1);
  });
});
