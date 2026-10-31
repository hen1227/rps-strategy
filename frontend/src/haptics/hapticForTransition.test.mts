import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { gameHapticForTransition, offerArrived } from './hapticForTransition.ts';
import { VERDICT_DELAY_MS } from './recipes.ts';
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

/** Only what the haptic choice reads. */
const game = (
  moveNumber: number,
  currentTurn: PlayerColor,
  grid: Tile[][],
  extra: Partial<ActiveGame> = {},
) =>
  ({
    gameId: 'g',
    moveNumber,
    currentTurn,
    status: 'InProgress',
    winner: 'Neutral',
    grid,
    ...extra,
  }) as unknown as ActiveGame;

const quiet = position([
  { color: 'Blue', piece: 'Rock', x: 0, y: 0 },
  { color: 'Red', piece: 'Paper', x: 2, y: 2 },
]);
const blueStepped = position([
  { color: 'Blue', piece: 'Rock', x: 1, y: 1 },
  { color: 'Red', piece: 'Paper', x: 2, y: 2 },
]);
// Blue's scissors next to Red's paper, then on its square.
const beforeTake = position([
  { color: 'Blue', piece: 'Scissors', x: 0, y: 0 },
  { color: 'Red', piece: 'Paper', x: 1, y: 0 },
  { color: 'Red', piece: 'Rock', x: 2, y: 2 },
]);
const afterTake = position([
  { color: 'Blue', piece: 'Scissors', x: 1, y: 0 },
  { color: 'Red', piece: 'Rock', x: 2, y: 2 },
]);

describe('what a move feels like', () => {
  it('taps for the other side, and not for your own', () => {
    const before = game(3, 'Blue', quiet);
    const after = game(4, 'Red', blueStepped);
    // Blue moved. Red feels it arrive; Blue felt it under the finger already.
    assert.deepEqual(gameHapticForTransition(before, after, 'Red'), {
      kind: 'haptic',
      event: 'theirMove',
    });
    assert.equal(gameHapticForTransition(before, after, 'Blue'), null);
  });

  it('is a capture when the other side takes, and nothing when you did', () => {
    const before = game(7, 'Blue', beforeTake);
    const after = game(8, 'Red', afterTake);
    assert.deepEqual(gameHapticForTransition(before, after, 'Red'), {
      kind: 'haptic',
      event: 'captured',
    });
    assert.equal(gameHapticForTransition(before, after, 'Blue'), null);
  });

  it('is nothing at all for somebody watching', () => {
    const before = game(7, 'Blue', beforeTake);
    const after = game(8, 'Red', afterTake);
    assert.equal(gameHapticForTransition(before, after, 'Neutral'), null);
    assert.equal(
      gameHapticForTransition(before, game(8, 'Red', afterTake, { status: 'Finished', winner: 'Blue' }), 'Neutral'),
      null,
    );
  });

  it('is nothing at a shared board, where every move was a touch on this phone', () => {
    const local = { local: {} } as Partial<ActiveGame>;
    const before = game(7, 'Blue', beforeTake, local);
    const after = game(8, 'Red', afterTake, local);
    assert.equal(gameHapticForTransition(before, after, null), null);
  });
});

describe('what a game starting feels like', () => {
  it('buzzes for an online game you are in', () => {
    assert.deepEqual(gameHapticForTransition(null, game(0, 'Blue', quiet), 'Red'), {
      kind: 'buzz',
      moment: 'gameStart',
    });
  });

  it('does not buzz for a game you started yourself, or one you only watch', () => {
    assert.equal(gameHapticForTransition(null, game(0, 'Blue', quiet, { bot: {} } as Partial<ActiveGame>), 'Blue'), null);
    assert.equal(gameHapticForTransition(null, game(0, 'Blue', quiet, { local: {} } as Partial<ActiveGame>), null), null);
    assert.equal(gameHapticForTransition(null, game(0, 'Blue', quiet), 'Neutral'), null);
  });

  it('does not buzz for a game rejoined part-way through', () => {
    assert.equal(gameHapticForTransition(null, game(12, 'Blue', quiet), 'Red'), null);
  });
});

describe('what a game ending feels like', () => {
  const ending = (winner: PlayerColor, extra: Partial<ActiveGame> = {}) =>
    [
      game(9, 'Blue', quiet, extra),
      game(10, 'Red', blueStepped, { ...extra, status: 'Finished', winner }),
    ] as const;

  it('is the result, a beat after the move', () => {
    const [before, after] = ending('Blue');
    assert.deepEqual(gameHapticForTransition(before, after, 'Blue'), {
      kind: 'haptic',
      event: 'win',
      delayMs: VERDICT_DELAY_MS,
    });
    assert.equal(gameHapticForTransition(before, after, 'Red')?.kind, 'haptic');
    assert.equal((gameHapticForTransition(before, after, 'Red') as { event: string }).event, 'loss');
    const [drawnBefore, drawn] = ending('Neutral');
    assert.equal((gameHapticForTransition(drawnBefore, drawn, 'Red') as { event: string }).event, 'draw');
  });

  it('wins over the capture that ended it', () => {
    const before = game(7, 'Blue', beforeTake);
    const after = game(8, 'Red', afterTake, { status: 'Finished', winner: 'Blue' });
    assert.equal((gameHapticForTransition(before, after, 'Red') as { event: string }).event, 'loss');
  });

  it('is an ending without a winner at a shared board', () => {
    const [before, after] = ending('Blue', { local: {} } as Partial<ActiveGame>);
    assert.equal((gameHapticForTransition(before, after, null) as { event: string }).event, 'ended');
  });

  it('is felt when the clock or a resignation ends it between moves', () => {
    const before = game(10, 'Red', quiet);
    const after = game(10, 'Red', quiet, { status: 'Finished', winner: 'Red' });
    assert.equal((gameHapticForTransition(before, after, 'Red') as { event: string }).event, 'win');
  });
});

describe('an offer from the other side', () => {
  it('is news when it first names your opponent', () => {
    const before = game(5, 'Red', quiet);
    assert.equal(offerArrived(before, game(5, 'Red', quiet, { drawOfferedBy: 'Blue' }), 'Red'), true);
    assert.equal(offerArrived(before, game(5, 'Red', quiet, { timeOfferedBy: 'Blue' }), 'Red'), true);
  });

  it('is not news when it is yours, or already standing', () => {
    const offered = game(5, 'Red', quiet, { drawOfferedBy: 'Blue' });
    assert.equal(offerArrived(game(5, 'Red', quiet), offered, 'Blue'), false);
    assert.equal(offerArrived(offered, offered, 'Red'), false);
    assert.equal(offerArrived(game(5, 'Red', quiet), offered, 'Neutral'), false);
  });
});
