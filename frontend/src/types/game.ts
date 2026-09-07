
// The game as the server describes it.
//
// Every type here mirrors a Go struct in `backend/internal/game`, field for
// field and name for name, because both ends read the same JSON. When a
// struct there gains a field, it belongs here too — that is the only thing
// keeping the client's idea of a game and the server's from drifting apart.

/**
 * The side of the standard board, and the size of every built-in mode.
 *
 * A default rather than a rule: a spec-defined mode may be any rectangle within
 * `MIN_BOARD_SIDE` and `MAX_BOARD_SIDE`, so nothing may bound a coordinate
 * against this. Read the shape off the grid with `boardWidth`/`boardHeight`, or
 * ask `isOnBoard`.
 */
export const BOARD_SIZE = 9;

/** A board with somewhere to move. Mirrors `game.MinBoardSide` in the backend. */
export const MIN_BOARD_SIDE = 3;

/**
 * Twenty-six because a file is one letter, `a` to `z`, in every notation this
 * project writes. Mirrors `game.MaxBoardSide`.
 */
export const MAX_BOARD_SIDE = 26;

/** Mirrors `game.MaxBoardTiles`: a cap on how much work one position can be. */
export const MAX_BOARD_TILES = 361;

/**
 * What stands on a tile.
 *
 * Deliberately open, for the same reason `ModeID` is: the set of kinds is
 * decided by a mode, and a mode may be one somebody wrote this morning. The
 * three literals are the kinds the built-in modes use and the ones fixtures and
 * piece-keyed tables are checked against; a spec-defined mode declares its own,
 * and **a kind's id in the spec is exactly the string that appears here** — one
 * name per piece, with no translation table between the rules and the board.
 *
 * `Empty` is the one reserved value. Mirrors `game.Piece` in the backend, which
 * is an open string for the same reason.
 */
export type Piece = 'Empty' | 'Rock' | 'Paper' | 'Scissors' | (string & {});

/** A piece that can actually stand on the board. */
export type PlayablePiece = 'Rock' | 'Paper' | 'Scissors' | (string & {});

/** The kinds the built-in modes play with, not the kinds that exist. */
export const PLAYABLE_PIECES: readonly PlayablePiece[] = ['Rock', 'Paper', 'Scissors'];

export type PlayerColor = 'Neutral' | 'Red' | 'Blue';

/** A colour that can own a piece and take a turn. `Neutral` cannot. */
export type SideColor = Exclude<PlayerColor, 'Neutral'>;

export const SIDE_COLORS: readonly SideColor[] = ['Red', 'Blue'];

/**
 * The other side.
 *
 * Only defined for the two playing colours: there is no opponent of `Neutral`,
 * and a caller that needs one is asking the wrong question.
 */
export const opposingColor = (color: SideColor): SideColor =>
  color === 'Red' ? 'Blue' : 'Red';

/**
 * The side that opens a game, and so the side written like White.
 *
 * It takes the `1.` in a PGN, it is the seat matchmaking hands to whoever asked
 * for the game, and it is drawn at the bottom of the board for a spectator.
 * Named rather than spelled out at each of those places because they are all
 * the same fact — and because it mirrors `game.FirstToMove` in the backend,
 * which is where the rule actually lives.
 */
export const FIRST_TO_MOVE: SideColor = 'Blue';

/**
 * Deliberately opaque. The backend registry decides which modes exist, and a
 * newly registered mode may use any stable id, so nothing here may assume the
 * set is closed. The three literals are the ones that exist today and are
 * spelled out only so that fixtures and mode-keyed tables can be checked.
 */
export type ModeID = 'V5' | 'V3' | 'V6' | (string & {});

/**
 * A rule or a display fact a mode declares, from the backend's own
 * `ModeFeature`. `territory` is drawn; the other two are rules the engine here
 * has to follow, because this module replays games the server adjudicated.
 */
export type ModeFeature = 'territory' | 'no_repetition_draw' | 'stalemate_loses';

export type GameStatus = 'InProgress' | 'Finished';

export type GameEndReason =
  | 'game_rule'
  | 'annihilation'
  | 'territory'
  | 'infiltration'
  | 'corner'
  | 'timeout'
  | 'resignation'
  | 'draw_agreement'
  | 'repetition'
  | 'stalemate'
  | 'abandonment'
  | 'no_capture'
  | 'move_limit';

/**
 * A board as rows of characters: upper case Blue, lower case Red, `.` empty.
 *
 * Rectangular, and no longer nine by nine — a spec-defined mode may be any
 * shape `isBoardRows` accepts. The number of rows is the board's height and
 * their common length is its width, so a layout needs nothing beside it to say
 * what shape it is. Mirrors `game.StartingPosition` in the backend, whose JSON
 * is this shape even though the Go type stores one string.
 */
export interface StartingPosition {
  rows: string[];
}

/**
 * Whether an unknown value is a board layout: a rectangle of rows, within the
 * sizes this project can play, name and draw.
 *
 * One implementation rather than one per screen. Two places decode a layout
 * that arrived over the wire — a mode's own opening and the lobby's compact
 * live board — and a disagreement between them shows up as one screen drawing a
 * board the other calls malformed.
 */
export const isBoardRows = (rows: unknown): rows is string[] => {
  if (!Array.isArray(rows)) return false;
  const height = rows.length;
  const width = typeof rows[0] === 'string' ? rows[0].length : -1;
  if (
    height < MIN_BOARD_SIDE ||
    height > MAX_BOARD_SIDE ||
    width < MIN_BOARD_SIDE ||
    width > MAX_BOARD_SIDE ||
    width * height > MAX_BOARD_TILES
  ) {
    return false;
  }
  return rows.every((row) => typeof row === 'string' && row.length === width);
};

/**
 * The engine rules a custom game switched off.
 *
 * Every field is a *deviation*, so an all-false value is the normal game. That
 * is what lets the lobby render one icon per non-standard field and nothing at
 * all for an ordinary match.
 */
export interface RuleFlags {
  noRepetitionDraw?: boolean;
  noDrawOffers?: boolean;
  noTimeExtensions?: boolean;
}

/**
 * The complete description of a game somebody wants to play.
 *
 * The same value covers a matchmaking search and a posted challenge, because
 * they are the same act: a search carries the mode's standard setup, and a
 * challenge carries an edited one. Anything left out is filled in from the mode
 * by the server, so an empty setup asks for a normal rated match.
 */
export interface GameSetup {
  modeId: ModeID;
  timeControl: TimeControl;
  startingPosition: StartingPosition;
  rules: RuleFlags;
  /** Casual games leave ratings alone. Stored as the deviation from rated. */
  casual?: boolean;
  /** The seat its author wants. Absent means either. */
  preferredColor?: SideColor;
}

/**
 * A relabelling of the board that leaves a mode alone, and so one under which
 * two positions are the same position.
 *
 * Colour-preserving, all of them: the side to move stays where it was, which is
 * what makes it honest to add two folded positions' Red and Blue wins together.
 *
 * - `mirror-files` — reflect across the middle file, a↔i on a nine-wide board.
 *   The symmetry of a mode raced across the ranks: Total War, Infiltration.
 * - `diagonal` — reflect across the a1–i9 diagonal, so e3↔c5. The symmetry of a
 *   mode raced along it: Intransitive, whose two goal corners are the two
 *   squares this reflection leaves alone.
 *
 * Declared by the server, which owns the rules. Nothing here computes one: the
 * explorer asks for a board by the line it walked and is answered in its own
 * coordinates.
 */
export type BoardSymmetry = 'mirror-files' | 'diagonal';

export interface ModeDefinition {
  id: ModeID;
  shortCode: string;
  name: string;
  description: string;
  objective: string;
  displayOrder: number;
  playable: boolean;
  features: ModeFeature[];
  startingPosition: StartingPosition;
  /**
   * The relabellings this mode's boards are unchanged by, under which the
   * opening statistics count a position and its reflection as one position.
   *
   * Optional because a mode fabricated in the Lab declares none, and because a
   * server that predates the field sends none. Absent reads as "nothing is
   * folded", which is the safe answer rather than a guess.
   */
  symmetries?: BoardSymmetry[];
  /**
   * The day this mode's rules last changed, `YYYY-MM-DD`.
   *
   * Optional because a mode fabricated in the Lab has no publication date, and
   * because a server that predates the field sends none.
   */
  rulesPublished?: string;
}

export const modeHasFeature = (mode: ModeDefinition | null | undefined, feature: ModeFeature) =>
  Boolean(mode?.features?.includes(feature));

export interface PlayerProfile {
  userId: string;
  username: string;
  discord?: string;
  /**
   * The short tag worn in front of the name — `GM`, `DEV` — and absent for most
   * players. At most three characters, which every row that draws one budgets
   * for. See `TitleTag`.
   */
  title?: string;
}

export interface Tile {
  x: number;
  y: number;
  occupant: Piece;
  occupantOwner: PlayerColor;
  ownerColor: PlayerColor;
}

export interface Position {
  x: number;
  y: number;
}

/** A move as both ends of the wire spell it. */
export interface Move {
  from: Position;
  to: Position;
}

/**
 * The board. Nine rows of nine tiles, indexed `grid[y][x]`.
 *
 * Typed as a plain nested array rather than a fixed-length tuple: it arrives
 * as JSON, so its shape is the server's promise rather than something the
 * compiler can hold us to, and pretending otherwise would only mean casting
 * at every boundary. Read it through `tileAt` where the coordinates are not
 * already known to be on the board.
 */
export type Grid = Tile[][];

/** The number of files, taken from the board itself. */
export const boardWidth = (grid: Grid | null | undefined) => grid?.[0]?.length ?? 0;

/** The number of ranks. */
export const boardHeight = (grid: Grid | null | undefined) => grid?.length ?? 0;

/**
 * Whether a coordinate is on this board.
 *
 * Takes the grid rather than assuming a size, which is the whole point: a
 * comparison against `BOARD_SIZE` would be wrong on any mode that is not nine
 * by nine.
 */
export const isOnBoard = (grid: Grid | null | undefined, { x, y }: Position) =>
  y >= 0 && y < (grid?.length ?? 0) && x >= 0 && x < (grid?.[y]?.length ?? 0);

/** The tile at a coordinate, or `null` when it is off the board. */
export const tileAt = (grid: Grid, x: number, y: number): Tile | null =>
  grid[y]?.[x] ?? null;

export const samePosition = (
  first: Position | null | undefined,
  second: Position | null | undefined,
) => Boolean(first && second && first.x === second.x && first.y === second.y);

export const sameMove = (first: Move | null | undefined, second: Move | null | undefined) =>
  Boolean(first && second && samePosition(first.from, second.from) && samePosition(first.to, second.to));

export interface TimeControl {
  initialTimeMs: number;
  incrementMs: number;
}

export interface ClockState {
  redRemainingMs: number;
  blueRemainingMs: number;
  activeColor: PlayerColor;
  updatedAtUnixMs: number;
}

export interface GameState {
  gameId: string;
  grid: Grid;
  mode: ModeDefinition;
  timeControl: TimeControl;
  /** The optional rules this game switched off. All-false is a normal game. */
  rules?: RuleFlags;
  clock: ClockState;
  currentTurn: PlayerColor;
  status: GameStatus;
  winner: PlayerColor;
  endReason?: GameEndReason;
  drawOfferedBy?: PlayerColor;
  drawOfferUsedBy?: PlayerColor;
  timeOfferedBy?: PlayerColor;
  timeOfferUsedBy?: PlayerColor;
  moveNumber: number;
  redPlayer: PlayerProfile;
  bluePlayer: PlayerProfile;
  /**
   * The game so far in the opening book's notation — `d8-c7`, squares only —
   * for as long as it is still an opening.
   *
   * The board cannot work this out for itself. A player who refreshed and a
   * spectator who arrived at move twenty never saw the moves that made the
   * opening, and they are exactly the people the badge is for, so the line
   * travels with the position instead. Absent is an answer: this game has no
   * opening to name, because it began from a board somebody drew.
   */
  openingLine?: string[];
}
