import { samePosition, type Grid, type PlayerColor, type Position } from '@/types/game';

// What a touch on the board should feel like.
//
// Judged by the board, at the moment of the touch, from what it is already
// drawing — not by the store, and not when the server echoes the move a round
// trip later. That is the whole point: online, nothing moves until the server
// answers, and the tap under the finger is what tells a player the board heard
// them.
//
// The rules, all of them from the player's side of the glass:
//
// - Touching one of your own pieces picks it up, whether the finger lands on
//   the piece (a drag beginning) or on the rest of its square (a tap). The
//   player cannot see where the piece's grip ends, so the two must feel the
//   same. Touching the piece already in your hand is putting it down, and is
//   felt as nothing.
// - Dragging over a square you could land on ticks, once per square — the same
//   rounding the drop uses, so a tick is a promise the drop keeps.
// - A move placed, by a drop or by a tap on a marked square, taps; firmer when
//   it lands on an enemy piece.
// - A drop on a square the board knows is not one of the piece's moves is
//   refused. Before the moves are known — a quick flick online — the board says
//   nothing and leaves the server to answer.
// - A board that will not take a move takes no touches either: spectating, a
//   replay, a finished game, a lesson that is not waiting.

export type BoardTouchFeel = 'pickUp' | 'hover' | 'commit' | 'captureCommit' | 'refused';

/** What the board is drawing, as far as a touch is concerned. */
export interface BoardTouchState {
  canMove: boolean;
  grid: Grid;
  /** The side whose pieces this board lets a finger move. */
  mover: PlayerColor | null | undefined;
  selectedTile: Position | null;
  validMoves: readonly Position[];
}

/** The moves a piece was showing when it was grabbed, kept for its drop. */
export interface MovesAtGrab {
  from: Position;
  moves: readonly Position[];
}

export type BoardTouch =
  /** A finger landing on a square: the grant of a drag, or a tap. */
  | { kind: 'press'; square: Position }
  /** A dragged piece now over a different square. */
  | { kind: 'over'; from: Position; over: Position; known: readonly Position[] }
  /** A dragged piece let go. */
  | { kind: 'drop'; from: Position; to: Position; known: readonly Position[] };

/**
 * Every move the board knows the piece at `from` has: the ones it showed when
 * it was grabbed, which a second press on a selected piece clears from the
 * store, and any that have arrived since.
 */
export const knownMoves = (
  board: BoardTouchState,
  from: Position,
  atGrab: MovesAtGrab | null,
): Position[] => [
  ...(atGrab && samePosition(atGrab.from, from) ? atGrab.moves : []),
  ...(samePosition(board.selectedTile, from) ? board.validMoves : []),
];

const listed = (moves: readonly Position[], square: Position) =>
  moves.some((move) => samePosition(move, square));

// A square a move can land on is never one's own, so anything standing on it
// is the enemy's.
const placed = (grid: Grid, square: Position): BoardTouchFeel => {
  const tile = grid[square.y]?.[square.x];
  return tile && tile.occupant !== 'Empty' ? 'captureCommit' : 'commit';
};

export const boardTouchHaptic = (
  board: BoardTouchState,
  touch: BoardTouch,
): BoardTouchFeel | null => {
  if (!board.canMove) return null;

  if (touch.kind === 'over') {
    if (samePosition(touch.over, touch.from)) return null;
    return listed(touch.known, touch.over) ? 'hover' : null;
  }

  if (touch.kind === 'drop') {
    // Put back where it came from, or let go off the board: nothing tried.
    if (samePosition(touch.from, touch.to) || touch.known.length === 0) return null;
    return listed(touch.known, touch.to) ? placed(board.grid, touch.to) : 'refused';
  }

  const { square } = touch;
  if (board.selectedTile && listed(board.validMoves, square)) return placed(board.grid, square);
  const tile = board.grid[square.y]?.[square.x];
  const mover = board.mover;
  if (!tile || tile.occupant === 'Empty' || (mover !== 'Red' && mover !== 'Blue')) return null;
  if (tile.occupantOwner !== mover) return null;
  return samePosition(board.selectedTile, square) ? null : 'pickUp';
};
