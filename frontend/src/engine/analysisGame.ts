// The rules, in the browser.
//
// A second implementation of the server's modes, and deliberately so: an
// analysis board, a bot game, and a replayed archive all need to know what a
// legal move is without asking anybody. Every rule here is the rule from
// `backend/internal/game`, and the comments mark the places where matching the
// server exactly is the whole point.

import { goalEndReason, goalOwnerAt, type RulesEra } from './goals';
import { QUIET_PLY_LIMIT, repetitionDraws, stalemateLoses } from './modeRules';
import { positionKey } from './positionKey';
import {
  BOARD_SIZE,
  FIRST_TO_MOVE,
  boardHeight,
  boardWidth,
  isOnBoard,
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

// The archive's squares, not a second convention: files run left to right and
// ranks from Blue's home boundary to Red's, exactly as
// `backend/internal/notation` writes them. A review shows a stored game, so
// the board it draws and the record it came from have to name a square the
// same way. Twenty-six letters because a mode may be that wide; the built-in
// modes use the first nine.
const FILES = 'abcdefghijklmnopqrstuvwxyz';

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
  /**
   * Moves played since the last capture, against `QUIET_PLY_LIMIT`.
   *
   * A number rather than a second history, because unlike repetition this rule
   * asks nothing about which positions were reached — only how long ago
   * something was taken.
   */
  quietPlies: number;
  /**
   * Which rules decide where this board is won — today's, or the ones in force
   * before the 2026-09-03 board flip. See `./goals`.
   *
   * Carried on the position rather than passed to `applyAnalysisMove`, because
   * every position in a replay belongs to one record and the whole line has to
   * be judged the same way. A game built any other way is `current`, which is
   * every live game, every local game and every position somebody set up.
   */
  era: RulesEra;
}

/**
 * The board a mode is played on.
 *
 * Read off the mode's own starting position rather than assumed, because a
 * spec-defined mode may be any rectangle. `BOARD_SIZE` is the fallback for a
 * synthetic mode built without one — a PGN whose tags were incomplete, say —
 * and never a bound on anything.
 */
export const modeBoardShape = (
  mode: Pick<ModeDefinition, 'startingPosition'> | null | undefined,
): { columns: number; rows: number } => {
  const rows = mode?.startingPosition?.rows;
  if (!rows?.length) return { columns: BOARD_SIZE, rows: BOARD_SIZE };
  return { columns: rows[0]?.length ?? BOARD_SIZE, rows: rows.length };
};

export const canCapture = (attacker: PlayablePiece, defender: PlayablePiece) =>
  (attacker === 'Rock' && defender === 'Scissors') ||
  (attacker === 'Scissors' && defender === 'Paper') ||
  (attacker === 'Paper' && defender === 'Rock');

// The hierarchy is a single three-cycle, so each kind has exactly one of each.
// Named after `PieceKind::predator` and `::prey` in `RPSFish/src/model.rs` so
// that a rule expressed in one language is greppable in the other two.

/** The one kind that captures this one. */
export const predatorOf = (piece: PlayablePiece): PlayablePiece =>
  piece === 'Rock' ? 'Paper' : piece === 'Paper' ? 'Scissors' : 'Rock';

/** The one kind this one captures. */
export const preyOf = (piece: PlayablePiece): PlayablePiece =>
  piece === 'Rock' ? 'Scissors' : piece === 'Paper' ? 'Rock' : 'Paper';

/**
 * What one letter in a layout means: which kind, and whose.
 *
 * Upper case is Blue and lower case is Red, which is the whole of the
 * convention. A mode that declares its own pieces brings its own alphabet —
 * `alphabetFor` in `spec/interpret.ts` builds one — because `L` is a Lizard in
 * a mode that has one and nothing at all in a mode that does not.
 */
export type PieceAlphabet = Record<string, { occupant: PlayablePiece; occupantOwner: SideColor }>;

/** The letters the built-in modes are written with. */
export const STANDARD_ALPHABET: PieceAlphabet = {
  R: { occupant: 'Rock', occupantOwner: 'Blue' },
  P: { occupant: 'Paper', occupantOwner: 'Blue' },
  S: { occupant: 'Scissors', occupantOwner: 'Blue' },
  r: { occupant: 'Rock', occupantOwner: 'Red' },
  p: { occupant: 'Paper', occupantOwner: 'Red' },
  s: { occupant: 'Scissors', occupantOwner: 'Red' },
};

/** Territory letters, the same `r`/`b` the FEN's third field is written with. */
const OWNER_LETTERS: Record<string, SideColor> = { r: 'Red', b: 'Blue' };

/**
 * A board from nine rows of `RPSrps.` symbols.
 *
 * Exported because a diagram of a starting position has rows and no game: the
 * lobby thumbnail draws one before anybody has played a move.
 *
 * `owners` is the territory, given as rows of `r`/`b`/`.` — the FEN's third
 * field in row form. Omitted, ownership follows the pieces, which is the shape
 * every mode's opening board has and the only one a layout string can describe.
 * Given, it replaces ownership outright rather than adding to it: a tile whose
 * owner row says `.` is unowned even with a piece standing on it, because that
 * is a board Total War can reach and a caller must be able to state it.
 */
export const gridFromRows = (
  rows: readonly string[] | undefined,
  alphabet: PieceAlphabet = STANDARD_ALPHABET,
  owners?: readonly string[],
): Grid =>
  Array.from({ length: rows?.length ?? BOARD_SIZE }, (_unusedRow, y) =>
    Array.from({ length: rows?.[y]?.length ?? BOARD_SIZE }, (_unusedTile, x): Tile => {
      const piece = alphabet[rows?.[y]?.[x] ?? ''];
      const occupantOwner = piece?.occupantOwner ?? 'Neutral';
      return {
        x,
        y,
        occupant: piece?.occupant ?? 'Empty',
        occupantOwner,
        ownerColor: owners ? (OWNER_LETTERS[owners[y]?.[x] ?? ''] ?? 'Neutral') : occupantOwner,
      };
    }),
  );

/** The territory of a board, in the row form `gridFromRows` reads back. */
export const ownerRowsFrom = (grid: Grid): string[] =>
  grid.map((row) =>
    row
      .map((tile) => (tile.ownerColor === 'Neutral' ? '.' : tile.ownerColor === 'Red' ? 'r' : 'b'))
      .join(''),
  );

/**
 * Everything about a position that decides whether it has been seen before.
 *
 * The answer itself lives in `positionKey.ts` so the spec interpreter can reach
 * it without importing this module back.
 */
export const repetitionKey = (game: PositionLike): string =>
  positionKey(game.grid, game.currentTurn);

const newGame = (
  mode: ModeDefinition,
  grid: Grid,
  currentTurn: SideColor,
  era: RulesEra = 'current',
): AnalysisGame => {
  const game = {
    endReason: null,
    era,
    grid,
    id: `analysis-${mode.id}`,
    mode,
    moveNumber: 0,
    currentTurn,
    quietPlies: 0,
    status: 'InProgress',
    winner: 'Neutral',
  } satisfies Omit<AnalysisGame, 'repetitionHistory'>;
  return { ...game, repetitionHistory: [repetitionKey(game)] };
};

export const createAnalysisGame = (
  mode: ModeDefinition,
  startingPosition: StartingPosition | undefined = mode.startingPosition,
): AnalysisGame =>
  newGame(mode, gridFromRows(startingPosition?.rows, alphabetOf(mode)), FIRST_TO_MOVE);

/**
 * The letters this mode's layouts are written with.
 *
 * Every mode uses the standard six. Kept as a function rather than inlined
 * because it is the one door every screen reaches the alphabet through, and a
 * format that declares its own pieces would change only this.
 */
export const alphabetOf = (_mode?: ModeDefinition | null): PieceAlphabet =>
  STANDARD_ALPHABET;

/** `gridFromRows` backwards: the letter a tile is written with. */
const pieceSymbol = (tile: Tile | undefined, alphabet: PieceAlphabet): string => {
  if (!tile || tile.occupant === 'Empty' || tile.occupantOwner === 'Neutral') return '.';
  for (const [symbol, piece] of Object.entries(alphabet)) {
    if (piece.occupant === tile.occupant && piece.occupantOwner === tile.occupantOwner) {
      return symbol;
    }
  }
  return '.';
};

export const startingPositionFromGrid = (
  grid: Grid | undefined,
  alphabet: PieceAlphabet = STANDARD_ALPHABET,
): StartingPosition => ({
  rows: Array.from({ length: boardHeight(grid) }, (_unusedRow, y) =>
    Array.from({ length: boardWidth(grid) }, (_unusedTile, x) =>
      pieceSymbol(grid?.[y]?.[x], alphabet),
    ).join(''),
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
  currentTurn: PlayerColor = FIRST_TO_MOVE,
  era: RulesEra = 'current',
): AnalysisGame =>
  newGame(
    mode,
    grid.map((row) => row.map((tile) => ({ ...tile }))),
    sideToMove(currentTurn),
    era,
  );

/**
 * The board a game begins from, when it is not the mode's own opening.
 *
 * Distinct from `StartingPosition`, which is rows of pieces and nothing else.
 * A board somebody set up also has a **side to move** — "Red to play" is half
 * of what makes a position a question rather than a picture — and, for a
 * position lifted out of an archived game, the rules era it was played under.
 * Those are the two fields the three-field FEN carries and a layout string
 * cannot, which is why a set-up board travels as this rather than as rows.
 */
export interface StartingBoard {
  grid: Grid;
  currentTurn?: PlayerColor;
  era?: RulesEra;
}

/**
 * The side a board is to be played from.
 *
 * Neutral and absent both read as the opener: a position with nobody to move is
 * a finished game or a board nobody has said anything about, and neither is
 * something to hand a player. One door for the question so the editor, the
 * sessions and `createAnalysisGameFrom` cannot answer it three ways.
 */
export const sideToMove = (turn: PlayerColor | undefined): SideColor =>
  turn === 'Red' || turn === 'Blue' ? turn : FIRST_TO_MOVE;

/**
 * A game on `start`'s board, or on the mode's own opening when there is none.
 *
 * The one place "no board given means the usual one" is decided, so the bot
 * session and the local session cannot drift on what an absent start means.
 */
export const createAnalysisGameOn = (
  mode: ModeDefinition,
  start?: StartingBoard | null,
): AnalysisGame =>
  start
    ? createAnalysisGameFrom(mode, start.grid, start.currentTurn, start.era)
    : createAnalysisGame(mode);

/**
 * The squares one piece could step to, whoever's turn it is.
 *
 * The movement rule on its own, with no game around it: eight neighbours, minus
 * the ones holding a friend, minus the ones holding an enemy this kind does not
 * beat. `validMovesFor` is this plus the turn, and the reach maps in
 * `engine/reach.ts` are this without one — asking where a piece *could* go is
 * not a question about whose move it is, and there must not be a second copy of
 * the rule to answer it.
 */
export const stepTargets = (
  grid: Grid,
  from: Position,
  mover: SideColor,
  piece: PlayablePiece,
): Position[] => {
  if (!isOnBoard(grid, from)) return [];
  const result: Position[] = [];
  for (let yOffset = -1; yOffset <= 1; yOffset += 1) {
    for (let xOffset = -1; xOffset <= 1; xOffset += 1) {
      if (xOffset === 0 && yOffset === 0) continue;
      const to = { x: from.x + xOffset, y: from.y + yOffset };
      if (!isOnBoard(grid, to)) continue;
      const destination = grid[to.y]?.[to.x];
      if (!destination) continue;
      if (destination.occupantOwner === mover) continue;
      if (destination.occupant !== 'Empty' && !canCapture(piece, destination.occupant)) {
        continue;
      }
      result.push(to);
    }
  }
  return result;
};

export const validMovesFor = (
  game: AnalysisGame | null | undefined,
  from: Position,
): Position[] => {
  if (!game || game.status !== 'InProgress' || !isOnBoard(game.grid, from)) return [];
  const source = game.grid[from.y]?.[from.x];
  if (!source || source.occupantOwner !== game.currentTurn) return [];
  if (source.occupant === 'Empty' || source.occupantOwner === 'Neutral') return [];
  return stepTargets(game.grid, from, source.occupantOwner, source.occupant);
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
    // A capture is the only thing that restarts the count. Territory is not:
    // claiming a tile is progress in Total War, but it is progress that mode
    // already ends the game on when the board fills.
    quietPlies: captured ? 0 : (game.quietPlies ?? 0) + 1,
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
    game.mode.id === 'V5' &&
    countPieces(grid, opposingColor(mover)) === 0
  ) {
    decide(mover, 'annihilation');
  } else if (
    goalOwnerAt(
      game.mode.id,
      to.x,
      to.y,
      { columns: boardWidth(grid), rows: boardHeight(grid) },
      game.era,
    ) === mover
  ) {
    // Non-null whenever `goalOwnerAt` named a side: both come from the same
    // pair of modes in `./goals`.
    decide(mover, goalEndReason(game.mode.id) ?? 'game_rule');
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

  // Being unable to move ends the game in every mode; who it belongs to is the
  // mode's to say. A shared result is what lets a mode with no annihilation
  // rule handle a wiped-out army; a loss is what stops a race being sat out.
  // See `./modeRules`, and `adjudicateStalemateLocked` in the backend.
  if (next.status === 'InProgress' && !hasAnyMove(next)) {
    next.status = 'Finished';
    next.winner = stalemateLoses(game.mode.id) ? mover : 'Neutral';
    next.endReason = 'stalemate';
  }

  const key = repetitionKey(next);
  next.repetitionHistory = [...(game.repetitionHistory ?? [repetitionKey(game)]), key];
  if (
    next.status === 'InProgress' &&
    repetitionDraws(game.mode.id) &&
    next.repetitionHistory.filter((candidate) => candidate === key).length >= 3
  ) {
    next.status = 'Finished';
    next.winner = 'Neutral';
    next.endReason = 'repetition';
  }

  // Last of the engine's endings, because it is the weakest claim any of them
  // makes: a move that wins, blockades, or repeats has said something about the
  // position, and "nothing has been taken for a while" must not overrule it.
  // `countQuietPlyLocked` in the backend adjudicates in the same order, and for
  // the same reason — otherwise the hundredth quiet move could turn a blockade,
  // which wins in a mode where being stuck loses, into half a point.
  if (next.status === 'InProgress' && next.quietPlies >= QUIET_PLY_LIMIT) {
    next.status = 'Finished';
    next.winner = 'Neutral';
    next.endReason = 'no_capture';
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

/**
 * The one letter a kind is written with: `R`, `P`, `S`.
 *
 * Case-free, unlike the record's `RPSrps` symbols, because this names a kind
 * rather than a kind belonging to a side — an overlay says `R5` and colours it
 * to say whose rock it is.
 */
export const pieceLetter = (piece: PlayablePiece) => piece.charAt(0).toUpperCase();

export const squareLabel = ({ x, y }: Position) => `${FILES[x] ?? '?'}${y + 1}`;

export const moveLabel = ({ from, to }: Move) => `${squareLabel(from)}–${squareLabel(to)}`;
