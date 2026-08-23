import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildReplayPieceTracks } from './replayAnimation.js';

const emptyGrid = () =>
  Array.from({ length: 3 }, (unusedRow, y) =>
    Array.from({ length: 3 }, (unusedTile, x) => ({
      occupant: 'Empty',
      occupantOwner: 'Neutral',
      x,
      y,
    })),
  );

const position = (pieces) => {
  const grid = emptyGrid();
  pieces.forEach(({ color, piece, x, y }) => {
    grid[y][x] = { ...grid[y][x], occupant: piece, occupantOwner: color };
  });
  return grid;
};

const at = (track, step) =>
  track.positions[step] && [track.positions[step].x, track.positions[step].y];

describe('replay piece tracks', () => {
  it('moves a piece forward and removes a capture at the boundary', () => {
    const before = position([
      { color: 'Red', piece: 'Rock', x: 0, y: 0 },
      { color: 'Blue', piece: 'Paper', x: 1, y: 0 },
    ]);
    const after = position([{ color: 'Red', piece: 'Rock', x: 1, y: 0 }]);
    const replay = buildReplayPieceTracks([before, after]);

    assert.equal(replay.steps, 1);
    const mover = replay.tracks.find((track) => track.color === 'Red');
    const captured = replay.tracks.find((track) => track.color === 'Blue');
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
    const replay = buildReplayPieceTracks([afterCapture, beforeCapture]);

    const mover = replay.tracks.find((track) => track.color === 'Red');
    const restored = replay.tracks.find((track) => track.color === 'Blue');
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
    const replay = buildReplayPieceTracks([afterB, afterA]);

    const pieceA = replay.tracks.find((track) => track.color === 'Red');
    const pieceB = replay.tracks.find((track) => track.color === 'Blue');
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
    const replay = buildReplayPieceTracks([first, second, third]);

    assert.equal(replay.steps, 2);
    const red = replay.tracks.find((track) => track.color === 'Red');
    const blue = replay.tracks.find((track) => track.color === 'Blue');
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
    const replay = buildReplayPieceTracks([third, second, first]);

    assert.equal(replay.steps, 2);
    const blue = replay.tracks.find((track) => track.color === 'Blue');
    const restoredRed = replay.tracks.find((track) => track.color === 'Red');
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
});
