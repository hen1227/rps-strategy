// Turn a run of board snapshots into piece tracks a replay can animate.
//
// The board draws from these rather than from the grids themselves, so a
// sixty-move game animates a few dozen persistent pieces instead of mounting
// a whole board per move.

import type { Piece, PlayerColor, Position, Tile } from '@/types/game';

/**
 * Anything that carries an occupant.
 *
 * Two spellings reach these helpers: a `Tile` from a grid, and a `PieceTrack`
 * built here. Accepting both is what lets the reconciliation below compare a
 * track against the square it is supposed to be standing on.
 */
interface OccupantLike {
  occupant?: Piece;
  occupantOwner?: PlayerColor;
  piece?: Piece;
  color?: PlayerColor;
}

const occupantSignature = (tile: OccupantLike | null | undefined) =>
  `${tile?.occupantOwner ?? tile?.color}:${tile?.occupant ?? tile?.piece}`;

const isOccupied = (tile: Tile | null | undefined) =>
  Boolean(tile?.occupant && tile.occupant !== 'Empty');

const sameOccupant = (first: OccupantLike, second: OccupantLike) =>
  occupantSignature(first) === occupantSignature(second);

const coordinateKey = ({ x, y }: Position) => `${x}:${y}`;

const tilesIn = (grid: Tile[][]) => grid.flat();

export const replayGridSignature = (grid: Tile[][]) =>
  grid.map((row) => row.map((tile) => occupantSignature(tile)).join(',')).join('|');

/** One piece's journey across the replay. `null` at a step means "not on the board". */
export interface PieceTrack {
  id: string;
  color: PlayerColor | undefined;
  piece: Piece | undefined;
  positions: (Position | null)[];
  startStep: number;
  endStep: number;
}

export interface ReplayTracks {
  steps: number;
  tracks: PieceTrack[];
}

const sameTrackPosition = (
  first: Position | null | undefined,
  second: Position | null | undefined,
) =>
  first === null || first === undefined
    ? second === null || second === undefined
    : second !== null &&
      second !== undefined &&
      first.x === second.x &&
      first.y === second.y;

const trackMatchesGrid = (track: PieceTrack, grid: Tile[][], step: number) => {
  const position = track.positions[step];
  const tile = position ? grid[position.y]?.[position.x] : undefined;
  return Boolean(tile && isOccupied(tile) && sameOccupant(track, tile));
};

/**
 * Keep only the tracks that actually change during a replay transition.
 *
 * The settled board remains mounted underneath the transition so its image
 * elements do not disappear and reappear around every move. A track belongs
 * in the animated layer when it moves, appears, or is captured; pieces that
 * occupy the same square in both endpoint grids can stay in the settled layer.
 */
export const animatedReplayPieceTracks = (
  replay: ReplayTracks,
  firstGrid: Tile[][],
  finalGrid: Tile[][],
) =>
  replay.tracks.filter((track) => {
    if (!trackMatchesGrid(track, firstGrid, 0)) return true;
    if (!trackMatchesGrid(track, finalGrid, replay.steps)) return true;
    return track.positions.some(
      (position, step) => step > 0 && !sameTrackPosition(track.positions[step - 1], position),
    );
  });

interface DetectedMove {
  color: PlayerColor;
  from: Position;
  piece: Piece;
  to: Position;
}

// A legal move changes exactly two occupied squares. Looking for the occupant
// that exists at one changed square before the transition and the other one
// afterwards works in both directions, including when rewinding a capture.
const moveBetween = (
  before: Tile[][] | undefined,
  after: Tile[][] | undefined,
): DetectedMove | null => {
  if (!before?.length || !after?.length || before.length !== after.length) return null;

  const changed: Position[] = [];
  for (let y = 0; y < before.length; y += 1) {
    const beforeRow = before[y];
    const afterRow = after[y];
    if (!beforeRow || !afterRow || beforeRow.length !== afterRow.length) return null;
    for (let x = 0; x < beforeRow.length; x += 1) {
      const beforeTile = beforeRow[x];
      const afterTile = afterRow[x];
      if (!beforeTile || !afterTile) return null;
      if (!sameOccupant(beforeTile, afterTile)) changed.push({ x, y });
    }
  }
  if (changed.length !== 2) return null;

  for (const from of changed) {
    const movingBefore = before[from.y]?.[from.x];
    if (!movingBefore || !isOccupied(movingBefore)) continue;
    const to = changed.find((position) => position !== from);
    const arriving = to ? after[to.y]?.[to.x] : undefined;
    if (to && arriving && sameOccupant(movingBefore, arriving)) {
      return {
        color: movingBefore.occupantOwner,
        from,
        piece: movingBefore.occupant,
        to,
      };
    }
  }
  return null;
};

/**
 * Turn a sequence of replay grids into a small set of persistent piece tracks.
 *
 * The returned tracks are driven by one animation clock in the board. Captures
 * change only their opacity at a move boundary, while every surviving piece
 * keeps a position at every boundary. This stays proportional to the number of
 * pieces, rather than mounting a complete board for every move in a long game.
 */
export const buildReplayPieceTracks = (grids: Tile[][][]): ReplayTracks | null => {
  if (!Array.isArray(grids) || grids.length < 2) return null;

  const moves: DetectedMove[] = [];
  for (let index = 0; index < grids.length - 1; index += 1) {
    const move = moveBetween(grids[index], grids[index + 1]);
    if (!move) return null;
    moves.push(move);
  }

  const steps = moves.length;
  const tracks: PieceTrack[] = [];
  const occupied = new Map<string, PieceTrack>();
  let nextId = 0;

  const addTrack = (tile: Tile, position: Position, startStep: number) => {
    const track: PieceTrack = {
      color: tile.occupantOwner,
      endStep: steps,
      id: `replay-piece-${nextId}`,
      piece: tile.occupant,
      positions: Array<Position | null>(steps + 1).fill(null),
      startStep,
    };
    nextId += 1;
    track.positions[startStep] = position;
    tracks.push(track);
    occupied.set(coordinateKey(position), track);
    return track;
  };

  const firstGrid = grids[0];
  if (!firstGrid) return null;
  for (const tile of tilesIn(firstGrid)) {
    if (isOccupied(tile)) addTrack(tile, { x: tile.x, y: tile.y }, 0);
  }

  const retireAt = (track: PieceTrack, position: Position, step: number) => {
    track.positions[step] = position;
    track.endStep = step;
  };

  for (let moveIndex = 0; moveIndex < moves.length; moveIndex += 1) {
    const move = moves[moveIndex];
    if (!move) return null;
    const boundary = moveIndex + 1;
    const fromKey = coordinateKey(move.from);
    const toKey = coordinateKey(move.to);
    const moving = occupied.get(fromKey);
    if (!moving || moving.piece !== move.piece || moving.color !== move.color) return null;

    const captured = occupied.get(toKey);
    if (captured) {
      retireAt(captured, move.to, boundary);
      occupied.delete(toKey);
    }
    occupied.delete(fromKey);
    occupied.set(toKey, moving);

    // Reconcile at the move boundary. In reverse, this is where a captured
    // piece is restored on the square the moving piece just vacated.
    const boundaryGrid = grids[boundary];
    if (!boundaryGrid) return null;
    for (const tile of tilesIn(boundaryGrid)) {
      const position = { x: tile.x, y: tile.y };
      const key = coordinateKey(position);
      const current = occupied.get(key);

      if (!isOccupied(tile)) {
        if (current) {
          retireAt(current, position, boundary);
          occupied.delete(key);
        }
        continue;
      }

      if (current && sameOccupant(current, tile)) continue;
      if (current) retireAt(current, position, boundary);
      addTrack(tile, position, boundary);
    }

    for (const [key, track] of occupied) {
      const [x, y] = key.split(':').map(Number);
      track.positions[boundary] = { x: x ?? 0, y: y ?? 0 };
    }
  }

  // A failed reconciliation means the inputs did not describe ordinary legal
  // moves. Declining to animate is safer than showing the wrong piece path.
  const finalGrid = grids[grids.length - 1];
  if (!finalGrid) return null;
  for (const tile of tilesIn(finalGrid)) {
    const track = occupied.get(coordinateKey(tile));
    if (isOccupied(tile) !== Boolean(track)) return null;
    if (track && !sameOccupant(track, tile)) return null;
  }

  return { steps, tracks };
};
