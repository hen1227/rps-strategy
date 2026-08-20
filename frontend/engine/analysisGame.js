const BOARD_SIZE = 9;
const FILES = 'ABCDEFGHI';

const otherColor = (color) => (color === 'Red' ? 'Blue' : 'Red');
const inBounds = ({ x, y }) => x >= 0 && x < BOARD_SIZE && y >= 0 && y < BOARD_SIZE;
const samePosition = (first, second) => first.x === second.x && first.y === second.y;

const canCapture = (attacker, defender) =>
  (attacker === 'Rock' && defender === 'Scissors') ||
  (attacker === 'Scissors' && defender === 'Paper') ||
  (attacker === 'Paper' && defender === 'Rock');

const PIECES = {
  R: { occupant: 'Rock', occupantOwner: 'Blue' },
  P: { occupant: 'Paper', occupantOwner: 'Blue' },
  S: { occupant: 'Scissors', occupantOwner: 'Blue' },
  r: { occupant: 'Rock', occupantOwner: 'Red' },
  p: { occupant: 'Paper', occupantOwner: 'Red' },
  s: { occupant: 'Scissors', occupantOwner: 'Red' },
};

const createGrid = (rows) =>
  Array.from({ length: BOARD_SIZE }, (_, y) =>
    Array.from({ length: BOARD_SIZE }, (_, x) => {
      const piece = PIECES[rows?.[y]?.[x]];
      return {
        x,
        y,
        occupant: piece?.occupant ?? 'Empty',
        occupantOwner: piece?.occupantOwner ?? 'Neutral',
        ownerColor: piece?.occupantOwner ?? 'Neutral',
      };
    }),
  );

const repetitionKey = (game) =>
  JSON.stringify([
    game.currentTurn,
    game.grid.map((row) =>
      row.map((tile) => [tile.occupant, tile.occupantOwner, tile.ownerColor]),
    ),
  ]);

export const createAnalysisGame = (mode) => {
  const game = {
    endReason: null,
    grid: createGrid(mode.startingPosition?.rows),
    id: `analysis-${mode.id}`,
    mode,
    moveNumber: 0,
    currentTurn: 'Red',
    status: 'InProgress',
    winner: 'Neutral',
  };
  return { ...game, repetitionHistory: [repetitionKey(game)] };
};

export const validMovesFor = (game, from) => {
  if (!game || game.status !== 'InProgress' || !inBounds(from)) return [];
  const source = game.grid[from.y][from.x];
  if (source.occupantOwner !== game.currentTurn) return [];

  const result = [];
  for (let yOffset = -1; yOffset <= 1; yOffset += 1) {
    for (let xOffset = -1; xOffset <= 1; xOffset += 1) {
      if (xOffset === 0 && yOffset === 0) continue;
      const to = { x: from.x + xOffset, y: from.y + yOffset };
      if (!inBounds(to)) continue;
      const destination = game.grid[to.y][to.x];
      if (destination.occupantOwner === game.currentTurn) continue;
      if (
        destination.occupant !== 'Empty' &&
        !canCapture(source.occupant, destination.occupant)
      ) {
        continue;
      }
      result.push(to);
    }
  }
  return result;
};

const countPieces = (grid, color) =>
  grid.flat().filter((tile) => tile.occupantOwner === color).length;

const territoryCounts = (grid) =>
  grid.flat().reduce(
    (counts, tile) => {
      if (tile.ownerColor === 'Red') counts.red += 1;
      else if (tile.ownerColor === 'Blue') counts.blue += 1;
      else counts.neutral += 1;
      return counts;
    },
    { blue: 0, neutral: 0, red: 0 },
  );

const hasAnyMove = (game) =>
  game.grid.some((row) =>
    row.some(
      (tile) =>
        tile.occupantOwner === game.currentTurn &&
        validMovesFor(game, { x: tile.x, y: tile.y }).length > 0,
    ),
  );

export const applyAnalysisMove = (game, from, to) => {
  if (!validMovesFor(game, from).some((candidate) => samePosition(candidate, to))) {
    return null;
  }

  const mover = game.currentTurn;
  const grid = game.grid.map((row) => row.map((tile) => ({ ...tile })));
  const source = grid[from.y][from.x];
  const destination = grid[to.y][to.x];
  const captured = destination.occupant !== 'Empty';

  destination.occupant = source.occupant;
  destination.occupantOwner = mover;
  source.occupant = 'Empty';
  source.occupantOwner = 'Neutral';
  if (game.mode.id === 'V5' && destination.ownerColor === 'Neutral') {
    destination.ownerColor = mover;
  }

  const next = {
    ...game,
    currentTurn: otherColor(mover),
    grid,
    moveNumber: game.moveNumber + 1,
  };

  if ((game.mode.id === 'V1' || game.mode.id === 'V5') && countPieces(grid, otherColor(mover)) === 0) {
    next.status = 'Finished';
    next.winner = mover;
    next.endReason = 'annihilation';
  } else if (
    game.mode.id === 'V3' &&
    ((mover === 'Red' && to.y === 0) || (mover === 'Blue' && to.y === BOARD_SIZE - 1))
  ) {
    next.status = 'Finished';
    next.winner = mover;
    next.endReason = 'infiltration';
  } else if (game.mode.id === 'V5') {
    const territory = territoryCounts(grid);
    if (territory.neutral === 0) {
      next.status = 'Finished';
      next.winner = territory.red === territory.blue ? 'Neutral' : territory.red > territory.blue ? 'Red' : 'Blue';
      next.endReason = 'territory';
    }
  }

  if (next.status === 'InProgress' && !hasAnyMove(next)) {
    next.status = 'Finished';
    next.winner = mover;
    next.endReason = 'no_legal_move';
  }

  const key = repetitionKey(next);
  next.repetitionHistory = [...(game.repetitionHistory ?? [repetitionKey(game)]), key];
  if (
    next.status === 'InProgress' &&
    next.repetitionHistory.filter((candidate) => candidate === key).length >= 3
  ) {
    next.status = 'Finished';
    next.winner = 'Neutral';
    next.endReason = 'repetition';
  }

  return { captured, game: next, mover };
};

export const moveLabel = ({ from, to }) =>
  `${FILES[from.x]}${BOARD_SIZE - from.y}–${FILES[to.x]}${BOARD_SIZE - to.y}`;

export const classifyMove = (bestScore, playedScore) => {
  const loss = Math.max(0, (bestScore ?? playedScore) - playedScore);
  if (loss <= 15) return { key: 'best', label: 'Best', loss };
  if (loss <= 50) return { key: 'excellent', label: 'Excellent', loss };
  if (loss <= 120) return { key: 'good', label: 'Good', loss };
  if (loss <= 260) return { key: 'inaccuracy', label: 'Inaccuracy', loss };
  if (loss <= 600) return { key: 'mistake', label: 'Mistake', loss };
  return { key: 'blunder', label: 'Blunder', loss };
};
