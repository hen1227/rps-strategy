import { gridFromRows } from '@/engine/analysisGame';
import { moveOnto, oneOf, reachableBy, type SolvePosition } from '@/engine/puzzleSolve';
import { BOARD_SIZE, type ModeID, type PlayablePiece, type Position } from '@/types/game';

// The first game: four positions, one idea each, played on the real board.
//
// Each is answered with one move, and each idea is one a new player needs
// before their first real game makes sense: how a piece moves and what takes
// what, that every piece is somebody's prey, how a game is won, and how a win
// is stopped. Where a wrong move has a punishment, the lesson plays it before
// taking the move back — the scissors snips the paper, the paper walks into the
// corner — because seeing it happen says more than any line under the board.
//
// The player is always Blue, the side that opens, so the board is drawn the way
// the real game draws it for somebody about to move first: home corner bottom
// left, theirs top right.
//
// Every position is written by hand. A lesson is a puzzle with a person's name
// on it, like any other, and nothing here is mined from games.

/** The mode the lessons teach, which is the main game. */
export const LESSON_MODE_ID: ModeID = 'V6';

/** The gentlest practice bot, for the first real game after the last lesson. */
export const FIRST_OPPONENT_ID = 'pebble';

export interface Lesson extends SolvePosition {
  id: string;
  title: string;
  /** What to do, said before the first move. */
  prompt: string;
  /** Said after a legal move that does not answer it. */
  hint: string;
  /** Said once it is answered. */
  success: string;
  /**
   * Wash every square where one of theirs could take a piece of this kind, so
   * "out of reach" is something on the board rather than something to imagine.
   */
  danger?: PlayablePiece;
}

const FILES = 'abcdefghi';

/** `d4` as a position: files left to right, rank 1 at Blue's end. */
export const square = (name: string): Position => ({
  x: FILES.indexOf(name[0] ?? ''),
  y: Number(name.slice(1)) - 1,
});

/** A move written as two squares. */
const move = (from: string, to: string) => ({ from: square(from), to: square(to) });

/**
 * A board holding only the pieces named, Blue to move.
 *
 * Written square by square rather than as nine rows of dots, because a lesson
 * has three or four pieces on it and a reader should be able to see which.
 * Upper case is Blue and lower case Red, as in every layout here.
 */
const position = (pieces: Record<string, string>) => {
  const letters = new Map(
    Object.entries(pieces).map(([name, letter]) => {
      const { x, y } = square(name);
      return [`${x}:${y}`, letter] as const;
    }),
  );
  const rows = Array.from({ length: BOARD_SIZE }, (_row, y) =>
    Array.from({ length: BOARD_SIZE }, (_tile, x) => letters.get(`${x}:${y}`) ?? '.').join(''),
  );
  return { grid: gridFromRows(rows), currentTurn: 'Blue' as const };
};

/** The corner Blue's army starts in: the one Red is racing for. */
const HOME_CORNER = square('a1');

export const LESSONS: readonly Lesson[] = [
  {
    id: 'capture',
    title: 'Rock beats scissors',
    // The one place the lessons say how a piece moves. Tapping the rock then
    // shows its eight squares, which says the rest.
    prompt: 'Pieces step one square, any way. Tap your rock, then take their scissors.',
    hint: 'Move your rock onto their scissors.',
    success: 'Rock takes scissors. Scissors takes paper. Paper takes rock.',
    board: position({ d4: 'R', c5: 'p', e5: 's' }),
    solves: oneOf(move('d4', 'e5')),
  },
  {
    id: 'run',
    title: 'Run away',
    prompt: 'Their scissors can take your paper. Step it off the orange squares.',
    hint: 'Scissors takes paper. Find a square no scissors can reach.',
    success: 'Safe. Before you move, check what can reach the square.',
    // The scissors on f5 is the one touching the paper; the one on c4 closes
    // the left, so five of the paper's seven steps are still in reach and only
    // e3 and f3 are out of it. The orange wash shows both scissors' reach, and
    // a wrong step is answered by the scissors that takes it.
    board: position({ e4: 'P', c4: 's', f5: 's' }),
    danger: 'Paper',
    solves: (played, after) => !reachableBy(after.grid, played.to, 'Red'),
    refute: (played, after) => moveOnto(after, played.to),
  },
  {
    id: 'corner',
    title: 'Take their corner',
    prompt: 'Land on the corner their army started in to win. Their rock is guarding it.',
    hint: 'Only paper takes rock.',
    success: 'You win. First to the other corner takes the game.',
    // All three of yours touch the corner, and only one of them can take what
    // stands on it — scissors lose to rock, and rock can't take rock.
    board: position({ h8: 'P', i8: 'R', h9: 'S', i9: 'r' }),
    solves: (_played, after) => after.winner === 'Blue' && after.endReason === 'corner',
  },
  {
    id: 'guard',
    title: 'Guard your corner',
    prompt: 'Their paper is one step from your corner. Stop it.',
    hint: "Their paper got in. Block the corner with a piece paper can't take.",
    success: "Blocked. Pieces of the same kind can't take each other.",
    // The rock is the piece that looks like a wall and the one paper takes.
    // Paper on paper is a stand-off, so the corner is shut. Every wrong answer
    // is shown by the paper stepping in and winning.
    board: position({ b1: 'P', a2: 'R', b2: 'p' }),
    solves: (_played, after) => !reachableBy(after.grid, HOME_CORNER, 'Red'),
    refute: (_played, after) => moveOnto(after, HOME_CORNER),
  },
];
