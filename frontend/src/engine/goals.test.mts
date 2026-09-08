// The goal rule, and the local rules that end a game on it.
//
// The three modes are checked together rather than one at a time, because the
// bug this guards against is a mode reading another mode's goal — a corner
// tinted on a board raced across the ranks, or a whole rank ending a game that
// is won at one corner of it.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { applyAnalysisMove, createAnalysisGame } from './analysisGame';
import { goalEndReason, goalOwnerAt, hasGoalTiles } from './goals';
import { testMode } from '@/testing/modes';
import type { SideColor } from '@/types/game';

const SHAPE = { columns: 9, rows: 9 };

/** Every tile some side wins by standing on, as `x,y` keys. */
const goalTiles = (modeId: string): Map<string, SideColor> => {
  const found = new Map<string, SideColor>();
  for (let y = 0; y < SHAPE.rows; y += 1) {
    for (let x = 0; x < SHAPE.columns; x += 1) {
      const owner = goalOwnerAt(modeId, x, y, SHAPE);
      if (owner) found.set(`${x},${y}`, owner);
    }
  }
  return found;
};

describe('goalOwnerAt', () => {
  it('gives Infiltration the two home ranks', () => {
    const tiles = goalTiles('V3');
    assert.equal(tiles.size, SHAPE.columns * 2);
    assert.equal(tiles.get('0,0'), 'Red');
    assert.equal(tiles.get('8,0'), 'Red');
    assert.equal(tiles.get('0,8'), 'Blue');
    assert.equal(tiles.get('4,4'), undefined);
  });

  it('gives Intransitive one corner each and nothing else', () => {
    assert.deepEqual(
      [...goalTiles('V6')].sort(),
      [
        ['0,0', 'Red'],
        ['8,8', 'Blue'],
      ],
    );
  });

  it('gives Total War and an unknown mode no goal at all', () => {
    assert.equal(goalTiles('V5').size, 0);
    assert.equal(goalTiles('nothing-like-it').size, 0);
    assert.equal(hasGoalTiles('V5'), false);
    assert.equal(hasGoalTiles('V6'), true);
    assert.equal(goalEndReason('V6'), 'corner');
    assert.equal(goalEndReason('V5'), null);
  });

  it('measures the far edges from the board it is given, not from nine', () => {
    const small = { columns: 5, rows: 4 };
    assert.equal(goalOwnerAt('V6', 0, 0, small), 'Red');
    assert.equal(goalOwnerAt('V6', 4, 3, small), 'Blue');
    assert.equal(goalOwnerAt('V6', 8, 3, small), null);
    assert.equal(goalOwnerAt('V3', 0, 3, small), 'Blue');
  });
});

describe('applyAnalysisMove in Intransitive', () => {
  /**
   * One runner a step from each goal corner, so both wins are one move away,
   * and one spare piece each so that a move nobody wins with does not end the
   * game by leaving the other side with nothing to play.
   */
  const runners = () =>
    createAnalysisGame(testMode('V6'), {
      rows: [
        '.........',
        '.r.......',
        '....r....',
        '.........',
        '.........',
        '.........',
        '....R....',
        '.......R.',
        '.........',
      ],
    });

  it('ends the game when a piece lands on the far corner', () => {
    const applied = applyAnalysisMove({ ...runners(), currentTurn: 'Red' }, { x: 1, y: 1 }, { x: 0, y: 0 });
    assert.ok(applied);
    assert.equal(applied.game.status, 'Finished');
    assert.equal(applied.game.winner, 'Red');
    assert.equal(applied.game.endReason, 'corner');
    // A mode that ends the game on a move never passes the turn.
    assert.equal(applied.game.currentTurn, 'Red');
  });

  it('does not end it anywhere else on the same rank', () => {
    const applied = applyAnalysisMove({ ...runners(), currentTurn: 'Red' }, { x: 1, y: 1 }, { x: 1, y: 0 });
    assert.ok(applied);
    assert.equal(applied.game.status, 'InProgress');
    assert.equal(applied.game.endReason, null);
    assert.equal(applied.game.currentTurn, 'Blue');
  });

  it('ends it for Blue on the opposite corner', () => {
    const applied = applyAnalysisMove(runners(), { x: 7, y: 7 }, { x: 8, y: 8 });
    assert.ok(applied);
    assert.equal(applied.game.winner, 'Blue');
    assert.equal(applied.game.endReason, 'corner');
  });

  it('opens from a diagonal layout of ten pieces a side, neither on a goal', () => {
    const occupied = createAnalysisGame(testMode('V6')).grid.flat();
    assert.equal(occupied.filter((tile) => tile.occupantOwner === 'Red').length, 10);
    assert.equal(occupied.filter((tile) => tile.occupantOwner === 'Blue').length, 10);
    assert.equal(occupied.find((tile) => tile.x === 0 && tile.y === 0)?.occupant, 'Empty');
    assert.equal(occupied.find((tile) => tile.x === 8 && tile.y === 8)?.occupant, 'Empty');
  });

  it('opens with Blue banked in front of a1 and Red in front of i9', () => {
    const grid = createAnalysisGame(testMode('V6')).grid;
    // Rank 1 is row 0 and is the edge the board is drawn from, so Blue's wedge
    // is the bottom left of the picture and Red's the top right.
    assert.equal(grid[1][3].occupantOwner, 'Blue');
    assert.equal(grid[7][5].occupantOwner, 'Red');
  });
});
