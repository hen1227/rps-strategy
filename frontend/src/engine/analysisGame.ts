// The rules, in the browser.
//
// A second implementation of the server's modes, and deliberately so: an
// analysis board, a bot game, and a replayed archive all need to know what a
// legal move is without asking anybody. Every rule here is the rule from
// `backend/internal/game`, and the comments mark the places where matching the
// server exactly is the whole point.

import {
  BOARD_SIZE,
  opposingColor,
  samePosition,
  type GameEndReason,
  type GameStatus,
  type Grid,
  type ModeDefinition,
  type Move,
  type PlayablePiece,
  type PlayerColor,
  type Position,
  type SideColor,
  type StartingPosition,
  type Tile,
} from '@/types/game';

export { BOARD_SIZE };

// The archive's squares, not a second convention: files a to i run left to
// right and ranks 1 to 9 run from Blue's home boundary to Red's, exactly as
// `backend/internal/notation` writes them. A review shows a stored game, so
// the board it draws and the record it came from have to name a square the
// same way.
const FILES = 'abcdefghi';

/**
 * A position with everything needed to ask the engine about it.
 *
 * Both the server's `GameState` and this module's `AnalysisGame` satisfy it,
 * which is what lets one board component and one engine call serve a live
 * game, a replay, and a hand-built position.
 */
export interface PositionLike {
  grid: Grid;
  currentTurn: PlayerColor;
  mode: ModeDefinition;
  moveNumber: number;
}

/** A game being played out locally: no clock, no players, no server. */
export interface AnalysisGame extends PositionLike {
  id: string;
  status: GameStatus;
  winner: PlayerColor;
  endReason: GameEndReason | null;
  /** One entry per position reached, including the starting one. */
  repetitionHistory: string[];
}

const inBounds = ({ x, y }: Position) => x >= 0 && x < BOARD_SIZE && y >= 0 && y < BOARD_SIZE;

const canCapture = (attacker: PlayablePiece, defender: PlayablePiece) =>
  (attacker === 'Rock' && defender === 'Scissors') ||
  (attacker === 'Scissors' && defender === 'Paper') ||
  (attacker === 'Paper' && defender === 'Rock');

const PIECES: Record<string, { occupant: PlayablePiece; occupantOwner: SideColor }> = {
  R: { occupant: 'Rock', occupantOwner: 'Blue' },
  P: { occupant: 'Paper', occupantOwner: 'Blue' },
  S: { occupant: 'Scissors', occupantOwner: 'Blue' },
  r: { occupant: 'Rock', occupantOwner: 'Red' },
  p: { occupant: 'Paper', occupantOwner: 'Red' },
  s: { occupant: 'Scissors', occupantOwner: 'Red' },
};

const createGrid = (rows: readonly string[] | undefined): Grid =>
  Array.from({ length: BOARD_SIZE }, (_unusedRow, y) =>
    Array.from({ length: BOARD_SIZE }, (_unusedTile, x): Tile => {
      const piece = PIECES[rows?.[y]?.[x] ?? ''];
      return {
        x,
        y,
        occupant: piece?.occupant ?? 'Empty',
        occupantOwner: piece?.occupantOwner ?? 'Neutral',
        ownerColor: piece?.occupantOwner ?? 'Neutral',
      };
    }),
  );

const repetitionKey = (game: PositionLike): string =>
  JSON.stringify([
    game.currentTurn,
    game.grid.map((row) =>
      row.map((tile) => [tile.occupant, tile.occupantOwner, tile.ownerColor]),
    ),
  ]);

const newGame = (mode: ModeDefinition, grid: Grid, currentTurn: SideColor): AnalysisGame => {
  const game = {
    endReason: null,
    grid,
    id: `analysis-${mode.id}`,
    mode,
    moveNumber: 0,
    currentTurn,
    status: 'InProgress',
    winner: 'Neutral',
  } satisfies Omit<AnalysisGame, 'repetitionHistory'>;
  return { ...game, repetitionHistory: [repetitionKey(game)] };
};

export const createAnalysisGame = (
  mode: ModeDefinition,
  startingPosition: StartingPosition | undefined = mode.startingPosition,
): AnalysisGame => newGame(mode, createGrid(startingPosition?.rows), 'Red');

const SYMBOL_BY_PIECE: Record<SideColor, Record<PlayablePiece, string>> = {
  Blue: { Rock: 'R', Paper: 'P', Scissors: 'S' },
  Red: { Rock: 'r', Paper: 'p', Scissors: 's' },
};

const pieceSymbol = (tile: Tile | undefined): string => {
  if (!tile || tile.occupant === 'Empty') return '.';
  if (tile.occupantOwner === 'Neutral') return '.';
  return SYMBOL_BY_PIECE[tile.occupantOwner][tile.occupant] ?? '.';
};

export const startingPositionFromGrid = (grid: Grid | undefined): StartingPosition => ({
  rows: Array.from({ length: BOARD_SIZE }, (_unusedRow, y) =>
    Array.from({ length: BOARD_SIZE }, (_unusedTile, x) => pieceSymbol(grid?.[y]?.[x])).join(''),
  ),
});

/**
 * A board that starts from a given position rather than the mode's opening.
 *
 * Replaying an archived game needs this: the record stores the board it was
 * actually played from, so a mode whose opening position was redesigned later
 * still replays into the game that happened.
 */
export const createAnalysisGameFrom = (
  mode: ModeDefinition,
  grid: Grid,
  currentTurn: PlayerColor = 'Red',
): AnalysisGame =>
  newGame(
    mode,
    grid.map((row) => row.map((tile) => ({ ...tile }))),
    currentTurn === 'Blue' ? 'Blue' : 'Red',
  );

export const validMovesFor = (
  game: AnalysisGame | null | undefined,
  from: Position,
): Position[] => {
  if (!game || game.status !== 'InProgress' || !inBounds(from)) return [];
  const source = game.grid[from.y]?.[from.x];
  if (!source || source.occupantOwner !== game.currentTurn) return [];
  if (source.occupant === 'Empty') return [];

  const result: Position[] = [];
  for (let yOffset = -1; yOffset <= 1; yOffset += 1) {
    for (let xOffset = -1; xOffset <= 1; xOffset += 1) {
      if (xOffset === 0 && yOffset === 0) continue;
      const to = { x: from.x + xOffset, y: from.y + yOffset };
      if (!inBounds(to)) continue;
      const destination = game.grid[to.y]?.[to.x];
      if (!destination) continue;
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

const countPieces = (grid: Grid, color: PlayerColor) =>
  grid.flat().filter((tile) => tile.occupantOwner === color).length;

export interface TerritoryCounts {
  blue: number;
  neutral: number;
  red: number;
}

const territoryCounts = (grid: Grid): TerritoryCounts =>
  grid.flat().reduce<TerritoryCounts>(
    (counts, tile) => {
      if (tile.ownerColor === 'Red') counts.red += 1;
      else if (tile.ownerColor === 'Blue') counts.blue += 1;
      else counts.neutral += 1;
      return counts;
    },
    { blue: 0, neutral: 0, red: 0 },
  );

const hasAnyMove = (game: AnalysisGame) =>
  game.grid.some((row) =>
    row.some(
      (tile) =>
        tile.occupantOwner === game.currentTurn &&
        validMovesFor(game, { x: tile.x, y: tile.y }).length > 0,
    ),
  );

export interface AppliedMove {
  captured: boolean;
  game: AnalysisGame;
  mover: SideColor;
}

/** Play a move, or `null` when it is not legal from this position. */
export const applyAnalysisMove = (
  game: AnalysisGame,
  from: Position,
  to: Position,
): AppliedMove | null => {
  if (!validMovesFor(game, from).some((candidate) => samePosition(candidate, to))) {
    return null;
  }
  if (game.currentTurn === 'Neutral') return null;

  const mover: SideColor = game.currentTurn;
  const grid = game.grid.map((row) => row.map((tile) => ({ ...tile })));
  const source = grid[from.y]?.[from.x];
  const destination = grid[to.y]?.[to.x];
  if (!source || !destination) return null;
  const captured = destination.occupant !== 'Empty';

  destination.occupant = source.occupant;
  destination.occupantOwner = mover;
  source.occupant = 'Empty';
  source.occupantOwner = 'Neutral';
  if (game.mode.id === 'V5' && destination.ownerColor === 'Neutral') {
    destination.ownerColor = mover;
  }

  const next: AnalysisGame = {
    ...game,
    currentTurn: opposingColor(mover),
    grid,
    moveNumber: game.moveNumber + 1,
  };

  // A mode that ends the game on a move never passes the turn — the server's
  // modes return before `passTurn`, so the final position of a decided game
  // still has the winner to move. Stalemate and repetition are adjudicated
  // after the turn has already changed hands, so they keep it changed. The
  // difference is visible in every archived record's `FinalFEN`, and the
  // review replays those records.
  const decide = (winner: PlayerColor, endReason: GameEndReason) => {
    next.status = 'Finished';
    next.winner = winner;
    next.endReason = endReason;
    next.currentTurn = mover;
  };

  if (
    (game.mode.id === 'V1' || game.mode.id === 'V5') &&
    countPieces(grid, opposingColor(mover)) === 0
  ) {
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

/** The shape RPSFish expects for one position. */
export interface EnginePosition {
  currentTurn: PlayerColor;
  grid: Grid;
  modeId: string;
  moveNumber: number;
}

// The worker needs the mode, the side to move, and the move number alongside
// the grid, so every caller — analysis board, bot, arena — builds its request
// the same way.
export const enginePosition = (game: PositionLike): EnginePosition => ({
  currentTurn: game.currentTurn,
  grid: game.grid,
  modeId: game.mode.id,
  moveNumber: game.moveNumber,
});

// Every move the side to move may play, in board order. Bots use this to pick
// a deliberately random move, and the arena uses it to detect stalemate.
export const allValidMoves = (game: AnalysisGame | null | undefined): Move[] => {
  if (!game || game.status !== 'InProgress') return [];
  const moves: Move[] = [];
  for (const row of game.grid) {
    for (const tile of row) {
      if (tile.occupantOwner !== game.currentTurn) continue;
      const from = { x: tile.x, y: tile.y };
      for (const to of validMovesFor(game, from)) moves.push({ from, to });
    }
  }
  return moves;
};

export const squareLabel = ({ x, y }: Position) => `${FILES[x] ?? '?'}${y + 1}`;

export const moveLabel = ({ from, to }: Move) => `${squareLabel(from)}–${squareLabel(to)}`;
