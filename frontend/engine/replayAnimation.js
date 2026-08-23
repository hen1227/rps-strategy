const occupantSignature = (tile) =>
  `${tile?.occupantOwner ?? tile?.color}:${tile?.occupant ?? tile?.piece}`;

const isOccupied = (tile) => tile?.occupant && tile.occupant !== 'Empty';

const sameOccupant = (first, second) =>
  occupantSignature(first) === occupantSignature(second);

const coordinateKey = ({ x, y }) => `${x}:${y}`;

const tilesIn = (grid) => grid.flat();

export const replayGridSignature = (grid) =>
  grid.map((row) => row.map(occupantSignature).join(',')).join('|');

// A legal move changes exactly two occupied squares. Looking for the occupant
// that exists at one changed square before the transition and the other one
// afterwards works in both directions, including when rewinding a capture.
const moveBetween = (before, after) => {
  if (!before?.length || before.length !== after?.length) return null;

  const changed = [];
  for (let y = 0; y < before.length; y += 1) {
    if (before[y]?.length !== after[y]?.length) return null;
    for (let x = 0; x < before[y].length; x += 1) {
      if (!sameOccupant(before[y][x], after[y][x])) changed.push({ x, y });
    }
  }
  if (changed.length !== 2) return null;

  for (const from of changed) {
    const movingBefore = before[from.y][from.x];
    if (!isOccupied(movingBefore)) continue;
    const to = changed.find((position) => position !== from);
    if (to && sameOccupant(movingBefore, after[to.y][to.x])) {
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
export const buildReplayPieceTracks = (grids) => {
  if (!Array.isArray(grids) || grids.length < 2) return null;

  const moves = [];
  for (let index = 0; index < grids.length - 1; index += 1) {
    const move = moveBetween(grids[index], grids[index + 1]);
    if (!move) return null;
    moves.push(move);
  }

  const steps = moves.length;
  const tracks = [];
  const occupied = new Map();
  let nextId = 0;

  const addTrack = (tile, position, startStep) => {
    const track = {
      color: tile.occupantOwner,
      endStep: steps,
      id: `replay-piece-${nextId}`,
      piece: tile.occupant,
      positions: Array(steps + 1).fill(null),
      startStep,
    };
    nextId += 1;
    track.positions[startStep] = position;
    tracks.push(track);
    occupied.set(coordinateKey(position), track);
    return track;
  };

  for (const tile of tilesIn(grids[0])) {
    if (isOccupied(tile)) addTrack(tile, { x: tile.x, y: tile.y }, 0);
  }

  const retireAt = (track, position, step) => {
    track.positions[step] = position;
    track.endStep = step;
  };

  for (let moveIndex = 0; moveIndex < moves.length; moveIndex += 1) {
    const move = moves[moveIndex];
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
    for (const tile of tilesIn(grids[boundary])) {
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
      track.positions[boundary] = { x, y };
    }
  }

  // A failed reconciliation means the inputs did not describe ordinary legal
  // moves. Declining to animate is safer than showing the wrong piece path.
  const finalGrid = grids[grids.length - 1];
  for (const tile of tilesIn(finalGrid)) {
    const track = occupied.get(coordinateKey(tile));
    if (isOccupied(tile) !== Boolean(track)) return null;
    if (track && !sameOccupant(track, tile)) return null;
  }

  return { steps, tracks };
};
