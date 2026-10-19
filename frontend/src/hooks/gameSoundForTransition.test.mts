import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { getGameSoundForTransition } from './gameSoundForTransition';
import type { ActiveGame } from '@/store/types';
import type { Piece, PlayerColor, Tile } from '@/types/game';

interface Placement {
  color: PlayerColor;
  piece: Piece;
  x: number;
  y: number;
}

const position = (pieces: Placement[]): Tile[][] => {
  const grid = Array.from({ length: 3 }, (unusedRow, y) =>
    Array.from(
      { length: 3 },
      (unusedTile, x): Tile => ({
        occupant: 'Empty',
        occupantOwner: 'Neutral',
        ownerColor: 'Neutral',
        x,
        y,
      }),
    ),
  );
  pieces.forEach(({ color, piece, x, y }) => {
    grid[y]![x] = { ...grid[y]![x]!, occupant: piece, occupantOwner: color };
  });
  return grid;
};

/** Only what the sound choice reads. */
const game = (moveNumber: number, currentTurn: PlayerColor, grid: Tile[][]) =>
  ({ gameId: 'g', moveNumber, currentTurn, status: 'InProgress', grid }) as unknown as ActiveGame;

/** Blue's `taker` takes Red's `victim`, and it is Red's turn after. */
const capture = (taker: Piece, victim: Piece) => {
  const before = game(
    7,
    'Blue',
    position([
      { color: 'Blue', piece: taker, x: 0, y: 0 },
      { color: 'Red', piece: victim, x: 1, y: 0 },
      { color: 'Red', piece: 'Rock', x: 2, y: 2 },
    ]),
  );
  const after = game(
    8,
    'Red',
    position([
      { color: 'Blue', piece: taker, x: 1, y: 0 },
      { color: 'Red', piece: 'Rock', x: 2, y: 2 },
    ]),
  );
  return getGameSoundForTransition(before, after, 'Blue');
};

describe('the sound a capture makes', () => {
  // Every capture used to play the clip of the next matchup round the cycle:
  // the taker's piece was looked up in a table keyed by the piece that fell.
  it('is the clip of the throw that won', () => {
    assert.equal(capture('Rock', 'Scissors'), 'rockTakesScissors');
    assert.equal(capture('Scissors', 'Paper'), 'scissorsTakesPaper');
    assert.equal(capture('Paper', 'Rock'), 'paperTakesRock');
  });

  it('is a move sound for a move that takes nothing', () => {
    const before = game(3, 'Blue', position([{ color: 'Blue', piece: 'Rock', x: 0, y: 0 }]));
    const after = game(4, 'Red', position([{ color: 'Blue', piece: 'Rock', x: 1, y: 1 }]));
    assert.equal(getGameSoundForTransition(before, after, 'Blue'), 'moveSelf');
    assert.equal(getGameSoundForTransition(before, after, 'Red'), 'moveOpponent');
  });
});
