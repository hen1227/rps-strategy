import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { boardTouchHaptic, knownMoves, type BoardTouchState } from './touchHaptics.ts';
import type { Grid, Piece, PlayerColor, Position, Tile } from '@/types/game';

// A 3×3 board:
//
//   y=2   .   r   .        r: Red rock    (a Blue paper takes it)
//   y=1   .   P   S        P: Blue paper at b2, S: Blue scissors at c2
//   y=0   .   .   s        s: Red scissors (beats paper: not a move)
//
const tile = (x: number, y: number, piece: Piece = 'Empty', owner: PlayerColor = 'Neutral'): Tile => ({
  x,
  y,
  occupant: piece,
  occupantOwner: owner,
  ownerColor: 'Neutral',
});
const grid: Grid = [
  [tile(0, 0), tile(1, 0), tile(2, 0, 'Scissors', 'Red')],
  [tile(0, 1), tile(1, 1, 'Paper', 'Blue'), tile(2, 1, 'Scissors', 'Blue')],
  [tile(0, 2), tile(1, 2, 'Rock', 'Red'), tile(2, 2)],
];

const at = (x: number, y: number): Position => ({ x, y });
const PAPER = at(1, 1);
const PAPER_MOVES = [at(0, 1), at(1, 2), at(0, 0), at(1, 0), at(0, 2)];

const board = (state: Partial<BoardTouchState> = {}): BoardTouchState => ({
  canMove: true,
  grid,
  mover: 'Blue',
  selectedTile: null,
  validMoves: [],
  ...state,
});
const selected = (state: Partial<BoardTouchState> = {}) =>
  board({ selectedTile: PAPER, validMoves: PAPER_MOVES, ...state });

describe('a finger landing on the board', () => {
  it('picks up your own piece, wherever on its square it lands', () => {
    assert.equal(boardTouchHaptic(board(), { kind: 'press', square: PAPER }), 'pickUp');
    // On the other side's turn too: the piece stays in hand through their move.
    assert.equal(boardTouchHaptic(board({ validMoves: [] }), { kind: 'press', square: at(2, 1) }), 'pickUp');
  });

  it('picks up another of your pieces while one is in hand', () => {
    assert.equal(boardTouchHaptic(selected(), { kind: 'press', square: at(2, 1) }), 'pickUp');
  });

  it('is nothing for the piece already in hand: that is putting it down', () => {
    assert.equal(boardTouchHaptic(selected(), { kind: 'press', square: PAPER }), null);
  });

  it('places a move on a marked square, firmer onto an enemy piece', () => {
    assert.equal(boardTouchHaptic(selected(), { kind: 'press', square: at(0, 1) }), 'commit');
    assert.equal(boardTouchHaptic(selected(), { kind: 'press', square: at(1, 2) }), 'captureCommit');
  });

  it('is nothing for a square that only clears the selection', () => {
    assert.equal(boardTouchHaptic(selected(), { kind: 'press', square: at(2, 2) }), null);
    assert.equal(boardTouchHaptic(selected(), { kind: 'press', square: at(2, 0) }), null);
    // A destination tapped before the moves have arrived.
    assert.equal(boardTouchHaptic(selected({ validMoves: [] }), { kind: 'press', square: at(0, 1) }), null);
  });

  it('is nothing for the other side’s pieces, or with nobody to move', () => {
    assert.equal(boardTouchHaptic(board(), { kind: 'press', square: at(1, 2) }), null);
    assert.equal(boardTouchHaptic(board({ mover: 'Neutral' }), { kind: 'press', square: PAPER }), null);
    assert.equal(boardTouchHaptic(board({ mover: null }), { kind: 'press', square: PAPER }), null);
  });

  it('is nothing at all on a board that takes no moves', () => {
    assert.equal(boardTouchHaptic(board({ canMove: false }), { kind: 'press', square: PAPER }), null);
    assert.equal(
      boardTouchHaptic(selected({ canMove: false }), { kind: 'press', square: at(1, 2) }),
      null,
    );
  });
});

describe('a piece being dragged', () => {
  const over = (square: Position, known = PAPER_MOVES, state = selected()) =>
    boardTouchHaptic(state, { kind: 'over', from: PAPER, over: square, known });

  it('ticks over a square it could land on, capture or not', () => {
    assert.equal(over(at(0, 1)), 'hover');
    assert.equal(over(at(1, 2)), 'hover');
  });

  it('is quiet over home, over squares it cannot reach, and before its moves are known', () => {
    assert.equal(over(PAPER), null);
    assert.equal(over(at(2, 2)), null);
    assert.equal(over(at(0, 1), []), null);
    assert.equal(over(at(0, 1), PAPER_MOVES, selected({ canMove: false })), null);
  });
});

describe('a piece let go', () => {
  const drop = (to: Position, known = PAPER_MOVES, state = selected()) =>
    boardTouchHaptic(state, { kind: 'drop', from: PAPER, to, known });

  it('places the move, firmer onto an enemy piece', () => {
    assert.equal(drop(at(0, 1)), 'commit');
    assert.equal(drop(at(1, 2)), 'captureCommit');
  });

  it('is refused on a square the board knows is not a move', () => {
    assert.equal(drop(at(2, 2)), 'refused');
    assert.equal(drop(at(2, 0)), 'refused');
  });

  it('says nothing before the moves are known, and nothing put back home', () => {
    assert.equal(drop(at(2, 2), []), null);
    assert.equal(drop(PAPER), null);
    assert.equal(drop(at(2, 2), PAPER_MOVES, selected({ canMove: false })), null);
  });

  it('keeps every promise a tick made', () => {
    for (let y = 0; y < 3; y += 1) {
      for (let x = 0; x < 3; x += 1) {
        const square = at(x, y);
        const ticked = boardTouchHaptic(selected(), {
          kind: 'over',
          from: PAPER,
          over: square,
          known: PAPER_MOVES,
        });
        const landed = drop(square);
        assert.equal(
          ticked === 'hover',
          landed === 'commit' || landed === 'captureCommit',
          `${x},${y}`,
        );
        // A tap and a drop on the same square agree about what it was.
        if (landed === 'commit' || landed === 'captureCommit') {
          assert.equal(boardTouchHaptic(selected(), { kind: 'press', square }), landed);
        }
      }
    }
  });
});

describe('the moves a dragged piece is known to have', () => {
  it('keeps the moves its grab cleared from the selection', () => {
    // A second press on a selected piece deselects it in the store.
    assert.deepEqual(knownMoves(board(), PAPER, { from: PAPER, moves: PAPER_MOVES }), PAPER_MOVES);
  });

  it('takes the moves that arrived after a fresh grab', () => {
    assert.deepEqual(knownMoves(selected(), PAPER, null), PAPER_MOVES);
  });

  it('ignores moves held for some other piece', () => {
    assert.deepEqual(knownMoves(selected(), at(2, 1), { from: PAPER, moves: PAPER_MOVES }), []);
  });
});
