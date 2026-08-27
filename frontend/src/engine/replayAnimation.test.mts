import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  animatedReplayPieceTracks,
  buildReplayPieceTracks,
  type ReplayTracks,
} from './replayAnimation';
import type { Piece, PlayerColor, Tile } from '@/types/game';

interface Placement {
  color: PlayerColor;
  piece: Piece;
  x: number;
  y: number;
}

const emptyGrid = (): Tile[][] =>
  Array.from({ length: 3 }, (unusedRow, y) =>
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

const position = (pieces: Placement[]): Tile[][] => {
  const grid = emptyGrid();
  pieces.forEach(({ color, piece, x, y }) => {
    grid[y]![x] = { ...grid[y]![x]!, occupant: piece, occupantOwner: color };
  });
  return grid;
};

/** Build tracks, failing the test rather than the type checker if they decline. */
const tracksOf = (grids: Tile[][][]): ReplayTracks => {
  const replay = buildReplayPieceTracks(grids);
  assert.ok(replay, 'these grids should have described legal moves');
  return replay;
};

const trackFor = (replay: ReplayTracks, color: PlayerColor) => {
  const track = replay.tracks.find((candidate) => candidate.color === color);
  assert.ok(track, `expected a ${color} track`);
  return track;
};

const at = (track: { positions: ({ x: number; y: number } | null)[] }, step: number) => {
  const position = track.positions[step];
  return position ? [position.x, position.y] : null;
};

describe('replay piece tracks', () => {
  it('moves a piece forward and removes a capture at the boundary', () => {
    const before = position([
      { color: 'Red', piece: 'Rock', x: 0, y: 0 },
      { color: 'Blue', piece: 'Paper', x: 1, y: 0 },
    ]);
    const after = position([{ color: 'Red', piece: 'Rock', x: 1, y: 0 }]);
    const replay = tracksOf([before, after]);

    assert.equal(replay.steps, 1);
    const mover = trackFor(replay, 'Red');
    const captured = trackFor(replay, 'Blue');
    assert.deepEqual([at(mover, 0), at(mover, 1)], [[0, 0], [1, 0]]);
    assert.equal(captured.startStep, 0);
    assert.equal(captured.endStep, 1);
  });

  it('moves backwards and restores a captured piece without replay state steps', () => {
    const beforeCapture = position([
      { color: 'Red', piece: 'Rock', x: 0, y: 0 },
      { color: 'Blue', piece: 'Paper', x: 1, y: 0 },
    ]);
    const afterCapture = position([{ color: 'Red', piece: 'Rock', x: 1, y: 0 }]);
    const replay = tracksOf([afterCapture, beforeCapture]);

    const mover = trackFor(replay, 'Red');
    const restored = trackFor(replay, 'Blue');
    assert.deepEqual([at(mover, 0), at(mover, 1)], [[1, 0], [0, 0]]);
    assert.equal(restored.startStep, 1);
    assert.equal(restored.endStep, 1);
    assert.deepEqual(at(restored, 1), [1, 0]);
  });

  it('rewinds only B after A moves and then B moves', () => {
    const afterA = position([
      { color: 'Red', piece: 'Rock', x: 1, y: 0 },
      { color: 'Blue', piece: 'Paper', x: 2, y: 0 },
    ]);
    const afterB = position([
      { color: 'Red', piece: 'Rock', x: 1, y: 0 },
      { color: 'Blue', piece: 'Paper', x: 2, y: 1 },
    ]);
    const replay = tracksOf([afterB, afterA]);

    const pieceA = trackFor(replay, 'Red');
    const pieceB = trackFor(replay, 'Blue');
    assert.deepEqual([at(pieceA, 0), at(pieceA, 1)], [[1, 0], [1, 0]]);
    assert.deepEqual([at(pieceB, 0), at(pieceB, 1)], [[2, 1], [2, 0]]);
  });

  it('tracks every mover through a multi-move jump with one clock', () => {
    const first = position([
      { color: 'Red', piece: 'Rock', x: 0, y: 0 },
      { color: 'Blue', piece: 'Paper', x: 2, y: 0 },
    ]);
    const second = position([
      { color: 'Red', piece: 'Rock', x: 1, y: 0 },
      { color: 'Blue', piece: 'Paper', x: 2, y: 0 },
    ]);
    const third = position([{ color: 'Blue', piece: 'Paper', x: 1, y: 0 }]);
    const replay = tracksOf([first, second, third]);

    assert.equal(replay.steps, 2);
    const red = trackFor(replay, 'Red');
    const blue = trackFor(replay, 'Blue');
    assert.deepEqual([at(red, 0), at(red, 1), at(red, 2)], [[0, 0], [1, 0], [1, 0]]);
    assert.deepEqual([at(blue, 0), at(blue, 1), at(blue, 2)], [[2, 0], [2, 0], [1, 0]]);
    assert.equal(red.endStep, 2);
  });

  it('rewinds a multi-move jump and restores pieces before moving them back', () => {
    const first = position([
      { color: 'Red', piece: 'Rock', x: 0, y: 0 },
      { color: 'Blue', piece: 'Paper', x: 2, y: 0 },
    ]);
    const second = position([
      { color: 'Red', piece: 'Rock', x: 1, y: 0 },
      { color: 'Blue', piece: 'Paper', x: 2, y: 0 },
    ]);
    const third = position([{ color: 'Blue', piece: 'Paper', x: 1, y: 0 }]);
    const replay = tracksOf([third, second, first]);

    assert.equal(replay.steps, 2);
    const blue = trackFor(replay, 'Blue');
    const restoredRed = trackFor(replay, 'Red');
    assert.deepEqual([at(blue, 0), at(blue, 1), at(blue, 2)], [[1, 0], [2, 0], [2, 0]]);
    assert.equal(restoredRed.startStep, 1);
    assert.deepEqual([at(restoredRed, 1), at(restoredRed, 2)], [[1, 0], [0, 0]]);
  });

  it('declines to animate a bulk board replacement', () => {
    const before = position([{ color: 'Red', piece: 'Rock', x: 0, y: 0 }]);
    const after = position([
      { color: 'Red', piece: 'Paper', x: 1, y: 1 },
      { color: 'Blue', piece: 'Scissors', x: 2, y: 2 },
    ]);
    assert.equal(buildReplayPieceTracks([before, after]), null);
  });

  it('animates only pieces that move, appear, or are captured', () => {
    const before = position([
      { color: 'Red', piece: 'Rock', x: 0, y: 0 },
      { color: 'Blue', piece: 'Paper', x: 1, y: 0 },
      { color: 'Blue', piece: 'Scissors', x: 2, y: 2 },
    ]);
    const after = position([
      { color: 'Red', piece: 'Rock', x: 1, y: 0 },
      { color: 'Blue', piece: 'Scissors', x: 2, y: 2 },
    ]);
    const replay = tracksOf([before, after]);
    const animated = animatedReplayPieceTracks(replay, before, after);

    assert.deepEqual(
      animated.map((track) => `${track.color}:${track.piece}`).sort(),
      ['Blue:Paper', 'Red:Rock'],
    );
  });

  it('animates a piece restored while rewinding but leaves bystanders settled', () => {
    const beforeCapture = position([
      { color: 'Red', piece: 'Rock', x: 0, y: 0 },
      { color: 'Blue', piece: 'Paper', x: 1, y: 0 },
      { color: 'Blue', piece: 'Scissors', x: 2, y: 2 },
    ]);
    const afterCapture = position([
      { color: 'Red', piece: 'Rock', x: 1, y: 0 },
      { color: 'Blue', piece: 'Scissors', x: 2, y: 2 },
    ]);
    const replay = tracksOf([afterCapture, beforeCapture]);
    const animated = animatedReplayPieceTracks(replay, afterCapture, beforeCapture);

    assert.deepEqual(
      animated.map((track) => `${track.color}:${track.piece}`).sort(),
      ['Blue:Paper', 'Red:Rock'],
    );
  });
});
