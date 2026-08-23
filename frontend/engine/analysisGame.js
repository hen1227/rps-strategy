const BOARD_SIZE = 9;
// The archive's squares, not a second convention: files a to i run left to
// right and ranks 1 to 9 run from Blue's home boundary to Red's, exactly as
// `backend/internal/notation` writes them. A review shows a stored game, so
// the board it draws and the record it came from have to name a square the
// same way.
const FILES = 'abcdefghi';

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

const newGame = (mode, grid, currentTurn) => {
  const game = {
    endReason: null,
    grid,
    id: `analysis-${mode.id}`,
    mode,
    moveNumber: 0,
    currentTurn,
    status: 'InProgress',
    winner: 'Neutral',
  };
  return { ...game, repetitionHistory: [repetitionKey(game)] };
};

export const createAnalysisGame = (mode, startingPosition = mode.startingPosition) =>
  newGame(mode, createGrid(startingPosition?.rows), 'Red');

const SYMBOL_BY_PIECE = {
  Blue: { Rock: 'R', Paper: 'P', Scissors: 'S' },
  Red: { Rock: 'r', Paper: 'p', Scissors: 's' },
};

export const startingPositionFromGrid = (grid) => ({
  rows: Array.from({ length: BOARD_SIZE }, (_, y) =>
    Array.from({ length: BOARD_SIZE }, (_, x) => {
      const tile = grid?.[y]?.[x];
      return SYMBOL_BY_PIECE[tile?.occupantOwner]?.[tile?.occupant] ?? '.';
    }).join(''),
  ),
});

/**
 * A board that starts from a given position rather than the mode's opening.
 *
 * Replaying an archived game needs this: the record stores the board it was
 * actually played from, so a mode whose opening position was redesigned later
 * still replays into the game that happened.
 */
export const createAnalysisGameFrom = (mode, grid, currentTurn = 'Red') =>
  newGame(
    mode,
    grid.map((row) => row.map((tile) => ({ ...tile }))),
    currentTurn === 'Blue' ? 'Blue' : 'Red',
  );

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

  // A mode that ends the game on a move never passes the turn — the server's
  // modes return before `passTurn`, so the final position of a decided game
  // still has the winner to move. Stalemate and repetition are adjudicated
  // after the turn has already changed hands, so they keep it changed. The
  // difference is visible in every archived record's `FinalFEN`, and the
  // review replays those records.
  const decide = (winner, endReason) => {
    next.status = 'Finished';
    next.winner = winner;
    next.endReason = endReason;
    next.currentTurn = mover;
  };

  if ((game.mode.id === 'V1' || game.mode.id === 'V5') && countPieces(grid, otherColor(mover)) === 0) {
    decide(mover, 'annihilation');
  } else if (
    game.mode.id === 'V3' &&
    ((mover === 'Red' && to.y === 0) || (mover === 'Blue' && to.y === BOARD_SIZE - 1))
  ) {
    decide(mover, 'infiltration');
  } else if (game.mode.id === 'V5') {
    const territory = territoryCounts(grid);
    if (territory.neutral === 0) {
      decide(
        territory.red === territory.blue
          ? 'Neutral'
          : territory.red > territory.blue
            ? 'Red'
            : 'Blue',
        'territory',
      );
    }
  }

  // Stalemate is a draw in every mode. The server and RPSFish both score a
  // player with no legal move as a shared result, so a mode needs no
  // annihilation rule to handle a wiped-out army.
  if (next.status === 'InProgress' && !hasAnyMove(next)) {
    next.status = 'Finished';
    next.winner = 'Neutral';
    next.endReason = 'stalemate';
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

// The shape RPSFish expects. The worker needs the mode, the side to move, and
// the move number alongside the grid, so every caller — analysis board, bot,
// arena — builds its request the same way.
export const enginePosition = (game) => ({
  currentTurn: game.currentTurn,
  grid: game.grid,
  modeId: game.mode.id,
  moveNumber: game.moveNumber,
});

// Every move the side to move may play, in board order. Bots use this to pick
// a deliberately random move, and the arena uses it to detect stalemate.
export const allValidMoves = (game) => {
  if (!game || game.status !== 'InProgress') return [];
  const moves = [];
  for (const row of game.grid) {
    for (const tile of row) {
      if (tile.occupantOwner !== game.currentTurn) continue;
      const from = { x: tile.x, y: tile.y };
      for (const to of validMovesFor(game, from)) moves.push({ from, to });
    }
  }
  return moves;
};

export const squareLabel = ({ x, y }) => `${FILES[x]}${y + 1}`;

export const moveLabel = ({ from, to }) => `${squareLabel(from)}–${squareLabel(to)}`;
