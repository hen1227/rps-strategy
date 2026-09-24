import assert from 'node:assert/strict';
import test from 'node:test';

import { createLocalSlice, type LocalSlice } from './localSession.ts';
import type { ActiveGame } from './types.ts';
import { createAnalysisGame, gridFromRows, type StartingBoard } from '../engine/analysisGame.ts';
import { encodePosition } from '../engine/pgn.ts';
import { STANDARD_OPENING_ROWS, testMode } from '../testing/modes.ts';
import type { Move, Position } from '../types/game.ts';

// The slice is exercised directly rather than through `useGameStore`, which
// would drag the socket, the account and the browser's local storage into a
// Node test. A `StateCreator` is just a function of `set` and `get`, so a plain
// object standing in for the store is enough to play a whole game.

interface Harness {
  gameState: ActiveGame | null;
  lastMove: Move | null;
  selectedTile: Position | null;
  validMoves: Position[];
  error: string | null;
}

type Store = LocalSlice & Harness;

type Setter = (patch: Partial<Store> | ((current: Store) => Partial<Store>)) => void;
type Getter = () => Store;

const openGame = (start?: StartingBoard) => {
  let state = {} as Store;
  const set: Setter = (patch) => {
    state = { ...state, ...(typeof patch === 'function' ? patch(state) : patch) };
  };
  const get: Getter = () => state;
  const create = createLocalSlice as unknown as (
    set: Setter,
    get: Getter,
    api: unknown,
  ) => LocalSlice;

  state = {
    ...create(set, get, {}),
    gameState: null,
    lastMove: null,
    selectedTile: null,
    validMoves: [],
    error: null,
  };
  state.startLocalGame({ mode: testMode('V5'), start });
  return get;
};

/**
 * The board that `testMode` opens from: Blue on ranks 0–2, Red on 6–8. Each
 * side's rock rank steps toward the middle, so both openers are legal from the
 * start whichever order they are played in.
 */
const BLUE_PAWN: Position = { x: 3, y: 2 };
const BLUE_TARGET: Position = { x: 3, y: 3 };
const RED_PAWN: Position = { x: 3, y: 6 };
const RED_TARGET: Position = { x: 3, y: 5 };

/** Tap the piece, then tap where it goes — the way the board drives it. */
const play = (store: Store, from: Position, to: Position) => {
  store.localSelectTile(from);
  store.localSelectTile(to);
};

test('a local game opens with two named seats, no clock, and nobody on the server', () => {
  const get = openGame();
  const game = get().gameState;

  assert.ok(game);
  assert.equal(game.local?.viewColor, 'Blue');
  assert.equal(game.bot ?? null, null);
  assert.equal(game.clock, null);
  assert.equal(game.timeControl, null);
  assert.equal(game.redPlayer.username, 'Red');
  assert.equal(game.bluePlayer.username, 'Blue');
  assert.equal(game.currentTurn, 'Blue');
  assert.equal(game.status, 'InProgress');
});

test('one keyboard plays both sides', () => {
  const get = openGame();

  play(get(), BLUE_PAWN, BLUE_TARGET);
  assert.equal(get().gameState?.currentTurn, 'Red');
  assert.deepEqual(get().lastMove, { from: BLUE_PAWN, to: BLUE_TARGET });

  // The move that a bot board would refuse: the opponent's, made by the same
  // person.
  play(get(), RED_PAWN, RED_TARGET);
  assert.equal(get().gameState?.currentTurn, 'Blue');
  assert.equal(get().localMoves.length, 2);
  assert.deepEqual(
    get().localMoves.map((move) => move.player),
    ['Blue', 'Red'],
  );
});

test('undo takes back one move, not a move and a reply', () => {
  const get = openGame();
  play(get(), BLUE_PAWN, BLUE_TARGET);
  play(get(), RED_PAWN, RED_TARGET);

  get().undoLocalMove();

  // The reply is gone and the opening move is not: the bot board undoes two
  // because it has to get back to the player's own turn, and here every turn
  // is theirs.
  assert.equal(get().gameState?.currentTurn, 'Red');
  assert.equal(get().localMoves.length, 1);
  assert.deepEqual(get().lastMove, { from: BLUE_PAWN, to: BLUE_TARGET });
  assert.equal(get().gameState?.grid[RED_TARGET.y]?.[RED_TARGET.x]?.occupant, 'Empty');
});

test('flipping the board turns it round without touching the position', () => {
  const get = openGame();
  play(get(), BLUE_PAWN, BLUE_TARGET);
  const before = get().gameState?.grid;

  get().flipLocalBoard();

  assert.equal(get().gameState?.local?.viewColor, 'Red');
  assert.deepEqual(get().gameState?.grid, before);
  assert.equal(get().gameState?.currentTurn, 'Red');

  get().flipLocalBoard();
  assert.equal(get().gameState?.local?.viewColor, 'Blue');
});

test('the side to move is the side that resigns', () => {
  const get = openGame();
  play(get(), BLUE_PAWN, BLUE_TARGET);

  get().resignLocalGame();

  const game = get().gameState;
  assert.equal(game?.status, 'Finished');
  assert.equal(game?.winner, 'Blue');
  assert.equal(game?.endReason, 'resignation');
});

test('a draw is agreed in one press, because both players are in the room', () => {
  const get = openGame();
  play(get(), BLUE_PAWN, BLUE_TARGET);

  get().drawLocalGame();

  assert.equal(get().gameState?.winner, 'Neutral');
  assert.equal(get().gameState?.endReason, 'draw_agreement');
});

test('the record names both seats and says it was unrated', () => {
  const get = openGame();
  play(get(), BLUE_PAWN, BLUE_TARGET);
  get().drawLocalGame();

  const pgn = get().localGamePGN();
  assert.ok(pgn);
  assert.match(pgn, /\[Event "Local game"\]/);
  assert.match(pgn, /\[Red "Red"\]/);
  assert.match(pgn, /\[Blue "Blue"\]/);
  assert.match(pgn, /\[Ranked "false"\]/);
  assert.match(pgn, /\[Result "1\/2-1\/2"\]/);
});

test('a game nobody moved in has no record to review', () => {
  const get = openGame();
  assert.equal(get().localGamePGN(), null);
});

test('leaving takes the board off the screen and keeps nothing', () => {
  const get = openGame();
  play(get(), RED_PAWN, RED_TARGET);

  get().endLocalSession();

  assert.equal(get().gameState, null);
  assert.equal(get().localSession, null);
  assert.equal(get().localGame, null);
  assert.deepEqual(get().localMoves, []);
  assert.deepEqual(get().localHistory, []);
});


// --- a board somebody set up ----------------------------------------------
//
// The claim: a local game started from a position keeps all three of that
// position's parts — the pieces, whose move it is, and who owns what — and
// writes the board it was actually played from into its own record, so the
// review reads back the game that happened rather than the mode's opening.

/** The standard pieces, Red to play, and one tile Blue holds with nothing on it. */
const setUpBoard = (): StartingBoard => ({
  currentTurn: 'Red',
  grid: gridFromRows(STANDARD_OPENING_ROWS, undefined, [
    '...bbb...', '...bbb...', '...bbb...',
    '.........', '....b....', '.........',
    '...rrr...', '...rrr...', '...rrr...',
  ]),
});

test('a game started from a set-up board opens on it, Red to move', () => {
  const get = openGame(setUpBoard());
  const game = get().gameState;

  assert.ok(game);
  assert.equal(game.currentTurn, 'Red', 'the board said Red even though Blue opens');
  assert.equal(game.status, 'InProgress');
  assert.equal(
    get().localGame?.grid[4]?.[4]?.ownerColor,
    'Blue',
    'e5 is Blue ground with no piece on it, which a layout string cannot say',
  );
});

test('the record names the board it was played from, not the mode opening', () => {
  const start = setUpBoard();
  const get = openGame(start);
  play(get(), RED_PAWN, RED_TARGET);
  get().resignLocalGame();

  const pgn = get().localGamePGN();
  assert.ok(pgn, 'a game with a move in it has a record');
  const fen = /\[FEN "([^"]+)"\]/.exec(pgn)?.[1];
  assert.equal(fen, encodePosition(start.grid, 'Red'), 'the tag is the board set up');

  const opening = createAnalysisGame(testMode('V5'));
  assert.notEqual(
    fen,
    encodePosition(opening.grid, opening.currentTurn),
    'and is not the board the mode would have opened on',
  );
  assert.match(pgn, /\[SetUp "1"\]/);
});

test('a rematch replays the position, not the mode opening', () => {
  const get = openGame(setUpBoard());
  play(get(), RED_PAWN, RED_TARGET);
  get().restartLocalGame();

  const game = get().gameState;
  assert.equal(game?.currentTurn, 'Red', 'still Red to play');
  assert.equal(get().localGame?.grid[4]?.[4]?.ownerColor, 'Blue', 'still Blue ground on e5');
  assert.equal(get().localMoves.length, 0, 'and a fresh board');
});
