// The archive's PGN dialect, read and written in the browser.
//
// The server stores every game as text (see backend/docs/pgn.md) and the
// review screen replays that text, so this module has to agree with
// `backend/internal/notation` exactly — the same squares, the same move
// tokens, the same annotations. It is deliberately dependency-free and
// deliberately total: a record that cannot be understood raises rather than
// silently losing a move.
//
// Bot games have no server record at all, so `encodePGN` writes one from the
// browser's own move list. That is what lets one review screen serve both.

import {
  BOARD_SIZE,
  type GameEndReason,
  type GameStatus,
  type Grid,
  type Piece,
  type PlayablePiece,
  type PlayerColor,
  type Position,
  type SideColor,
  type Tile,
} from '@/types/game';

const FILES = 'abcdefghi';

export const RESULT_RED_WIN = '1-0';
export const RESULT_BLUE_WIN = '0-1';
export const RESULT_DRAW = '1/2-1/2';
export const RESULT_UNFINISHED = '*';

export type GameResult =
  | typeof RESULT_RED_WIN
  | typeof RESULT_BLUE_WIN
  | typeof RESULT_DRAW
  | typeof RESULT_UNFINISHED;

export const GENERATOR = 'rps-strategy-pgn/1';

const TAG_PATTERN = /^\[([A-Za-z0-9_]+)\s+"((?:[^"\\]|\\.)*)"\]$/;
const MOVE_PATTERN = /^([RPS])([a-i][1-9])([-x])([RPS]?)([a-i][1-9])(#?)$/;
const NUMBER_PATTERN = /^(\d+)\.(\.\.)?$/;
const ANNOTATION_PATTERN = /\[%([a-z]+)([^\]]*)\]/g;

const PIECE_LETTERS: Partial<Record<Piece, string>> = {
  Rock: 'R',
  Paper: 'P',
  Scissors: 'S',
};
const LETTER_PIECES: Record<string, PlayablePiece> = {
  R: 'Rock',
  P: 'Paper',
  S: 'Scissors',
};

// Rock takes only scissors, scissors only paper, paper only rock, so an
// attacker names its victim and a capture need not write it down.
const DEFEATS: Record<PlayablePiece, PlayablePiece> = {
  Rock: 'Scissors',
  Scissors: 'Paper',
  Paper: 'Rock',
};

export class PGNError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PGNError';
  }
}

export const formatSquare = ({ x, y }: Position) => {
  if (x < 0 || x >= BOARD_SIZE || y < 0 || y >= BOARD_SIZE) return '??';
  return `${FILES[x]}${y + 1}`;
};

export const parseSquare = (text: string | undefined): Position => {
  const x = FILES.indexOf(text?.[0] ?? '');
  const y = Number(text?.[1]) - 1;
  if (x < 0 || !Number.isInteger(y) || y < 0 || y >= BOARD_SIZE) {
    throw new PGNError(`"${text}" is not a square.`);
  }
  return { x, y };
};

/** One move as a record spells it, before any board is involved. */
export interface NotatedMove {
  piece: PlayablePiece;
  from: Position;
  to: Position;
  captured: Piece;
}

/** The move token a record uses: `Rd7-d6` quietly, `Rd7xd6` for a capture. */
export const formatMove = (
  { piece, from, to, captured }: NotatedMove,
  endsGame = false,
) => {
  const attacker = PIECE_LETTERS[piece] ?? '?';
  const separator = captured && captured !== 'Empty' ? 'x' : '-';
  // A victim the rules do not imply is spelled out, so a future mode with
  // different captures cannot lose information here.
  const victim =
    captured && captured !== 'Empty' && captured !== DEFEATS[piece]
      ? PIECE_LETTERS[captured] ?? '?'
      : '';
  return `${attacker}${formatSquare(from)}${separator}${victim}${formatSquare(to)}${
    endsGame ? '#' : ''
  }`;
};

export const parseMoveToken = (token: string): NotatedMove & { endsGame: boolean } => {
  const match = MOVE_PATTERN.exec(token);
  if (!match) throw new PGNError(`"${token}" is not a move.`);
  const piece = LETTER_PIECES[match[1]];
  if (!piece) throw new PGNError(`"${token}" names an unknown piece.`);
  let captured: Piece = 'Empty';
  if (match[3] === 'x') captured = match[4] ? LETTER_PIECES[match[4]] ?? 'Empty' : DEFEATS[piece];
  return {
    piece,
    from: parseSquare(match[2]),
    to: parseSquare(match[5]),
    captured,
    endsGame: match[6] === '#',
  };
};

// --- positions -------------------------------------------------------------

const SYMBOL_PIECES: Record<string, { occupant: PlayablePiece; owner: SideColor }> = {
  R: { occupant: 'Rock', owner: 'Blue' },
  P: { occupant: 'Paper', owner: 'Blue' },
  S: { occupant: 'Scissors', owner: 'Blue' },
  r: { occupant: 'Rock', owner: 'Red' },
  p: { occupant: 'Paper', owner: 'Red' },
  s: { occupant: 'Scissors', owner: 'Red' },
};

const TURN_CODES: Record<string, PlayerColor> = { r: 'Red', b: 'Blue', '-': 'Neutral' };

const decodeRows = (field: string, place: (x: number, y: number, symbol: string) => void) => {
  const rows = field.split('/');
  if (rows.length !== BOARD_SIZE) {
    throw new PGNError(`expected ${BOARD_SIZE} ranks, got ${rows.length}`);
  }
  rows.forEach((row, y) => {
    let x = 0;
    for (const symbol of row) {
      if (symbol >= '1' && symbol <= '9') {
        x += Number(symbol);
        continue;
      }
      if (symbol === '.') {
        x += 1;
        continue;
      }
      if (x >= BOARD_SIZE) throw new PGNError(`rank ${y + 1} overflows the board`);
      place(x, y, symbol);
      x += 1;
    }
    if (x !== BOARD_SIZE) {
      throw new PGNError(`rank ${y + 1} covers ${x} tiles, expected ${BOARD_SIZE}`);
    }
  });
};

export interface DecodedPosition {
  grid: Grid;
  currentTurn: PlayerColor;
}

/**
 * Read the archive's three-field position: pieces, side to move, territory.
 *
 * Territory is its own field because a tile can be owned by a player with no
 * piece on it, which is what decides Total War. When it is missing, ownership
 * follows the pieces — the shape every mode's opening board has.
 */
export const decodePosition = (text: string | null | undefined): DecodedPosition => {
  const grid: Grid = Array.from({ length: BOARD_SIZE }, (_unusedRow, y) =>
    Array.from(
      { length: BOARD_SIZE },
      (_unusedTile, x): Tile => ({
        x,
        y,
        occupant: 'Empty',
        occupantOwner: 'Neutral',
        ownerColor: 'Neutral',
      }),
    ),
  );
  const at = (x: number, y: number): Tile => {
    const tile = grid[y]?.[x];
    if (!tile) throw new PGNError(`square ${x},${y} is off the board`);
    return tile;
  };
  const fields = String(text ?? '').trim().split(/\s+/).filter(Boolean);
  const pieceField = fields[0];
  if (pieceField === undefined) throw new PGNError('empty position');

  decodeRows(pieceField, (x, y, symbol) => {
    const piece = SYMBOL_PIECES[symbol];
    if (!piece) throw new PGNError(`unsupported piece "${symbol}"`);
    const tile = at(x, y);
    tile.occupant = piece.occupant;
    tile.occupantOwner = piece.owner;
    tile.ownerColor = piece.owner;
  });

  let currentTurn: PlayerColor = 'Neutral';
  const turnField = fields[1];
  if (turnField !== undefined) {
    const decoded = TURN_CODES[turnField];
    if (!decoded) throw new PGNError(`"${turnField}" is not a color`);
    currentTurn = decoded;
  }
  const territoryField = fields[2];
  if (territoryField !== undefined) {
    for (const row of grid) for (const tile of row) tile.ownerColor = 'Neutral';
    decodeRows(territoryField, (x, y, symbol) => {
      const owner = TURN_CODES[symbol];
      if (!owner || owner === 'Neutral') throw new PGNError(`unsupported territory "${symbol}"`);
      at(x, y).ownerColor = owner;
    });
  }
  return { grid, currentTurn };
};

const encodeRows = (grid: Grid, symbolFor: (tile: Tile) => string) =>
  grid
    .map((row) => {
      let text = '';
      let gap = 0;
      for (const tile of row) {
        const symbol = symbolFor(tile);
        if (!symbol) {
          gap += 1;
          continue;
        }
        if (gap > 0) {
          text += String(gap);
          gap = 0;
        }
        text += symbol;
      }
      return gap > 0 ? text + String(gap) : text;
    })
    .join('/');

const pieceSymbol = (tile: Tile) => {
  const letter = PIECE_LETTERS[tile.occupant];
  if (!letter) return '';
  return tile.occupantOwner === 'Red' ? letter.toLowerCase() : letter;
};

const TURN_SYMBOLS: Record<PlayerColor, string> = { Red: 'r', Blue: 'b', Neutral: '-' };

export const encodePosition = (grid: Grid, currentTurn: PlayerColor) =>
  [
    encodeRows(grid, pieceSymbol),
    TURN_SYMBOLS[currentTurn] ?? '-',
    encodeRows(grid, (tile) =>
      tile.ownerColor === 'Neutral' ? '' : TURN_SYMBOLS[tile.ownerColor],
    ),
  ].join(' ');

/** The row form `createAnalysisGame` builds a board from. */
export const startingRowsFrom = (grid: Grid) =>
  grid.map((row) => row.map((tile) => pieceSymbol(tile) || '.').join(''));

// --- reading ---------------------------------------------------------------

export interface PGNTag {
  name: string;
  value: string;
}

const unescapeTagValue = (value: string) => value.replace(/\\(.)/g, (_unused, character) => character);

const splitSections = (text: string) => {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const tags: PGNTag[] = [];
  const movetext: string[] = [];
  let inTags = true;
  for (const line of lines) {
    const trimmed = line.trim();
    if (inTags) {
      if (trimmed === '') continue;
      const match = TAG_PATTERN.exec(trimmed);
      if (match) {
        tags.push({ name: match[1], value: unescapeTagValue(match[2]) });
        continue;
      }
      inTags = false;
    }
    movetext.push(line);
  }
  if (tags.length === 0) throw new PGNError('no tag pairs');
  return { tags, movetext: movetext.join('\n') };
};

const tokenizeMovetext = (movetext: string) => {
  const tokens: string[] = [];
  let index = 0;
  while (index < movetext.length) {
    const character = movetext[index];
    if (character === ' ' || character === '\n' || character === '\t' || character === '\r') {
      index += 1;
    } else if (character === '{') {
      const end = movetext.indexOf('}', index);
      if (end < 0) throw new PGNError('unterminated comment');
      tokens.push(movetext.slice(index, end + 1));
      index = end + 1;
    } else {
      let end = index;
      while (end < movetext.length && !' \n\t\r{'.includes(movetext[end] ?? '')) end += 1;
      tokens.push(movetext.slice(index, end));
      index = end;
    }
  }
  return tokens;
};

const parseSecondsValue = (text: string) => {
  const [whole, fraction = ''] = String(text).split('.');
  const seconds = Number.parseInt(whole ?? '', 10);
  if (!Number.isFinite(seconds)) throw new PGNError(`bad seconds value "${text}"`);
  const padded = (fraction + '000').slice(0, 3);
  return seconds * 1000 + (fraction ? Number.parseInt(padded, 10) : 0);
};

const parseClock = (text: string) => {
  const parts = String(text).split(':');
  if (parts.length !== 3) throw new PGNError(`bad clock "${text}"`);
  return (
    Number.parseInt(parts[0] ?? '', 10) * 3_600_000 +
    Number.parseInt(parts[1] ?? '', 10) * 60_000 +
    parseSecondsValue(parts[2] ?? '')
  );
};

/**
 * A move's `[%act …]`: a draw agreed, or time added.
 *
 * The annotation's own word for what happened is `action` rather than `kind`,
 * so that an event carrying one keeps `kind: 'action'`. Spreading a `kind`
 * into an event that already had one is how the JavaScript version of this
 * module quietly relabelled every action event as its own verb.
 */
export interface PGNAction {
  action: string;
  player: string;
  bonusMs: number;
}

/** A game's `[%end …]`: why it ended, and who caused that. */
export interface PGNEnd {
  reason: string;
  player: string;
}

/** The clock annotations every event may carry. */
export interface PGNClock {
  elapsedMs: number;
  redRemainingMs: number | null;
  blueRemainingMs: number | null;
}

interface Annotations extends PGNClock {
  action?: PGNAction;
  end?: PGNEnd;
}

/** Just the clock, so an event is built from the parts it actually has. */
const clockOf = ({ elapsedMs, redRemainingMs, blueRemainingMs }: Annotations): PGNClock => ({
  elapsedMs,
  redRemainingMs,
  blueRemainingMs,
});

const parseComment = (token: string): Annotations => {
  const annotations: Annotations = { elapsedMs: 0, redRemainingMs: null, blueRemainingMs: null };
  ANNOTATION_PATTERN.lastIndex = 0;
  let match = ANNOTATION_PATTERN.exec(token);
  while (match) {
    const parts = match[2].trim().split(/\s+/).filter(Boolean);
    switch (match[1]) {
      case 'emt':
        annotations.elapsedMs = parseSecondsValue(parts[0] ?? '');
        break;
      case 'clk':
        annotations.redRemainingMs = parseClock(parts[0] ?? '');
        annotations.blueRemainingMs = parseClock(parts[1] ?? '');
        break;
      case 'act':
        annotations.action = {
          action: parts[0] ?? '',
          player: parts[1] ?? '',
          bonusMs: Number(parts[2] ?? 0),
        };
        break;
      case 'end':
        annotations.end = { reason: parts[0] ?? '', player: parts[1] ?? '' };
        break;
      default:
        break;
    }
    match = ANNOTATION_PATTERN.exec(token);
  }
  return annotations;
};

const RESULT_TOKENS = new Set<string>([
  RESULT_RED_WIN,
  RESULT_BLUE_WIN,
  RESULT_DRAW,
  RESULT_UNFINISHED,
]);

/** One thing that happened in a game, in the order the text records it. */
export type PGNEvent =
  | ({ kind: 'move'; player: SideColor; endsGame: boolean } & NotatedMove & PGNClock)
  | ({ kind: 'action' } & PGNAction & PGNClock)
  | ({ kind: 'end' } & PGNEnd & PGNClock);

export type PGNMoveEvent = Extract<PGNEvent, { kind: 'move' }>;

export interface ParsedPGN {
  tags: PGNTag[];
  /** A tag's value, or `''` when the record does not carry it. */
  tag: (name: string) => string;
  events: PGNEvent[];
  result: GameResult;
}

/**
 * Read one game.
 *
 * The result is deliberately close to the text: tag pairs, then the events in
 * the order they happened. Turning that into a board is `engine/gameReview`'s
 * job, because only it knows the mode rules.
 */
export const parsePGN = (text: string | null | undefined): ParsedPGN => {
  const { tags, movetext } = splitSections(String(text ?? ''));
  const lookup = new Map(tags.map((tag) => [tag.name, tag.value]));
  const events: PGNEvent[] = [];
  let result: GameResult = RESULT_UNFINISHED;
  let pendingMove: PGNMoveEvent | null = null;
  let color: SideColor = 'Red';

  const flush = () => {
    if (pendingMove) events.push(pendingMove);
    pendingMove = null;
  };

  for (const token of tokenizeMovetext(movetext)) {
    if (token.startsWith('{')) {
      const annotations = parseComment(token);
      if (annotations.end) {
        flush();
        events.push({ kind: 'end', ...annotations.end, ...clockOf(annotations) });
      } else if (annotations.action) {
        flush();
        events.push({ kind: 'action', ...annotations.action, ...clockOf(annotations) });
      } else if (pendingMove) {
        Object.assign(pendingMove, clockOf(annotations));
        flush();
      }
      continue;
    }
    if (RESULT_TOKENS.has(token)) {
      flush();
      result = token as GameResult;
      continue;
    }
    const numbered = NUMBER_PATTERN.exec(token);
    if (numbered) {
      flush();
      color = numbered[2] ? 'Blue' : 'Red';
      continue;
    }
    flush();
    pendingMove = {
      kind: 'move',
      player: color,
      elapsedMs: 0,
      redRemainingMs: null,
      blueRemainingMs: null,
      ...parseMoveToken(token),
    };
  }
  flush();

  const declared = lookup.get('Result');
  if (declared && result === RESULT_UNFINISHED) result = declared as GameResult;
  return {
    tags,
    tag: (name: string) => lookup.get(name) ?? '',
    events,
    result,
  };
};

// --- writing ---------------------------------------------------------------

const escapeTagValue = (value: unknown) => String(value ?? '').replace(/[\\"]/g, '\\$&');

const formatSecondsValue = (milliseconds: number) => {
  const whole = Math.trunc(milliseconds / 1000);
  const fraction = Math.abs(milliseconds % 1000);
  if (fraction === 0) return String(whole);
  return `${whole}.${String(fraction).padStart(3, '0')}`.replace(/0+$/, '');
};

const WRAP_COLUMN = 80;

const wrapTokens = (tokens: string[]) => {
  const lines: string[] = [];
  let line = '';
  for (const token of tokens) {
    if (line.length > 0 && line.length + 1 + token.length > WRAP_COLUMN) {
      lines.push(line);
      line = '';
    }
    line = line.length > 0 ? `${line} ${token}` : token;
  }
  if (line.length > 0) lines.push(line);
  return lines.join('\n');
};

// Endings a move caused, which is what "#" marks. Resigning, agreeing a draw,
// and running out of time are not caused by the move before them.
const ADJUDICATED_BY_A_MOVE = new Set<string>([
  'game_rule',
  'annihilation',
  'territory',
  'infiltration',
  'repetition',
  'stalemate',
]);

/** A move as `encodePGN` needs it: notation, whose it was, and its clock cost. */
export interface WritableMove extends NotatedMove {
  player: PlayerColor;
  elapsedMs?: number;
}

export interface EncodePGNInput {
  tags?: { name: string; value: unknown }[];
  moves?: WritableMove[];
  endReason?: GameEndReason | string | null;
  winner?: PlayerColor;
  result?: GameResult;
}

/**
 * Write a game as PGN.
 *
 * Bot games never reach the server, so this is the only record they will ever
 * have. It writes the same dialect the archive uses, which means the review
 * screen reads one format and the file can be pasted into any tool that reads
 * the archive.
 */
export const encodePGN = ({
  tags = [],
  moves = [],
  endReason,
  winner,
  result,
}: EncodePGNInput) => {
  const header = tags
    .filter((tag) => tag.value !== undefined && tag.value !== null && tag.value !== '')
    .map((tag) => `[${tag.name} "${escapeTagValue(tag.value)}"]`)
    .join('\n');

  const tokens: string[] = [];
  let moveNumber = 1;
  moves.forEach((move, index) => {
    tokens.push(move.player === 'Blue' ? `${moveNumber++}...` : `${moveNumber}.`);
    const endsGame =
      index === moves.length - 1 && Boolean(endReason) && ADJUDICATED_BY_A_MOVE.has(endReason ?? '');
    tokens.push(formatMove(move, endsGame));
    if (move.elapsedMs !== undefined) {
      tokens.push(`{[%emt ${formatSecondsValue(move.elapsedMs)}]}`);
    }
  });
  if (endReason) tokens.push(`{[%end ${endReason} ${winner ?? 'Neutral'}]}`);
  tokens.push(result ?? RESULT_UNFINISHED);
  return `${header}\n\n${wrapTokens(tokens)}\n`;
};

export const resultFor = (status: GameStatus | string, winner: PlayerColor): GameResult => {
  if (status !== 'Finished') return RESULT_UNFINISHED;
  if (winner === 'Red') return RESULT_RED_WIN;
  if (winner === 'Blue') return RESULT_BLUE_WIN;
  return RESULT_DRAW;
};

export const winnerFromResult = (result: GameResult | string): PlayerColor => {
  if (result === RESULT_RED_WIN) return 'Red';
  if (result === RESULT_BLUE_WIN) return 'Blue';
  return 'Neutral';
};
