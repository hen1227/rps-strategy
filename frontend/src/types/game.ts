// The game as the server describes it.
//
// Every type here mirrors a Go struct in `backend/internal/game`, field for
// field and name for name, because both ends read the same JSON. When a
// struct there gains a field, it belongs here too — that is the only thing
// keeping the client's idea of a game and the server's from drifting apart.

export const BOARD_SIZE = 9;

export type Piece = 'Empty' | 'Rock' | 'Paper' | 'Scissors';

/** A piece that can actually stand on the board. */
export type PlayablePiece = Exclude<Piece, 'Empty'>;

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
 * Deliberately opaque. The backend registry decides which modes exist, and a
 * newly registered mode may use any stable id, so nothing here may assume the
 * set is closed. The three literals are the ones that exist today and are
 * spelled out only so that fixtures and mode-keyed tables can be checked.
 */
export type ModeID = 'V5' | 'V3' | (string & {});

export type ModeFeature = 'territory';

export type GameStatus = 'InProgress' | 'Finished';

export type GameEndReason =
  | 'game_rule'
  | 'annihilation'
  | 'territory'
  | 'infiltration'
  | 'timeout'
  | 'resignation'
  | 'draw_agreement'
  | 'repetition'
  | 'stalemate'
  | 'abandonment'
  | 'move_limit';

/** Nine rows of nine characters: upper case Blue, lower case Red, `.` empty. */
export interface StartingPosition {
  rows: string[];
}

/**
 * The engine rules a custom game switched off, plus the one it added.
 *
 * Every field is a *deviation*, so an all-false value is the normal game. That
 * is what lets the lobby render one icon per non-standard field and nothing at
 * all for an ordinary match.
 */
export interface RuleFlags {
  noRepetitionDraw?: boolean;
  noDrawOffers?: boolean;
  noTimeExtensions?: boolean;
  /** A draw once this many moves have been played by both sides together. */
  moveLimit?: number;
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
}

export const modeHasFeature = (mode: ModeDefinition | null | undefined, feature: ModeFeature) =>
  Boolean(mode?.features?.includes(feature));

export interface PlayerProfile {
  userId: string;
  username: string;
  discord?: string;
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

export const isOnBoard = ({ x, y }: Position) =>
  x >= 0 && x < BOARD_SIZE && y >= 0 && y < BOARD_SIZE;

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
}
