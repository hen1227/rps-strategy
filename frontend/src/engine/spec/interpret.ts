// The rules, from a spec, in the browser.
//
// `analysisGame.ts` is the hand-written twin of the server's two shipped modes.
// This is its data-driven counterpart: given a `RuleSpec`, it answers the same
// two questions — what may move where, and what does playing a move do — for a
// mode nobody wrote code for.
//
// The authoritative copy is `backend/internal/game/spec`. Every rule here is the
// rule from there, and the comments mark the places where matching it exactly is
// the whole point. A shared corpus of positions is what actually holds the two
// together; see `conformance/`.
//
// Two decisions worth knowing before reading:
//
//  1. **A kind's id is the value on the tile.** A spec's `Rock` is
//     `tile.occupant === 'Rock'`. There is no translation table, which is why
//     the built-in specs use the names the wire has always used.
//  2. **Generation carries more than a destination.** A jump takes the piece it
//     jumped over, not the piece it landed on, so a generated move remembers
//     which rule produced it. Recomputing that at apply time would have to guess
//     between two rules that reach the same square.

import type { AnalysisGame, AppliedMove, PieceAlphabet, PositionLike } from '../analysisGame';
import { positionKey } from '../positionKey';
import {
  boardHeight,
  boardWidth,
  isOnBoard,
  opposingColor,
  samePosition,
  type Grid,
  type PlayablePiece,
  type PlayerColor,
  type ModeDefinition,
  type Position,
  type SideColor,
  type Tile,
} from '@/types/game';
import type {
  Directions,
  Effect,
  MovementRule,
  Predicate,
  Region,
  RuleSpec,
  SideRef,
  Term,
  TileFilter,
  WinResult,
} from './types';

/**
 * What a board needs in order to draw one kind of piece.
 *
 * Both fields, because both are fallbacks for each other: the artwork is what
 * you want, and the letter is what you get when there is none — or when the
 * artwork does not load. See `PieceIcon`.
 */
export interface PieceLook {
  symbol: string;
  /** A bundled artwork name, or `img:<digest>` for an uploaded one. */
  art?: string;
}

/* ------------------------------------------------------------------ lookups -- */

/**
 * `beats` as a set, built once per spec.
 *
 * A search asks this millions of times, and walking a list of pairs each time is
 * the difference between a bot that thinks and a bot that hangs. Keyed on the
 * spec object itself, so a spec being edited in the Lab gets a fresh set the
 * moment it changes identity.
 */
const beatsCache = new WeakMap<RuleSpec, Set<string>>();

const beatsSet = (spec: RuleSpec): Set<string> => {
  const cached = beatsCache.get(spec);
  if (cached) return cached;
  const built = new Set(spec.beats.map(([attacker, defender]) => `${attacker}>${defender}`));
  beatsCache.set(spec, built);
  return built;
};

/** Whether `attacker` may take `defender`, under this mode's capture rule. */
export const specCanCapture = (
  spec: RuleSpec,
  attacker: PlayablePiece,
  defender: PlayablePiece,
): boolean => {
  switch (spec.capture?.mode ?? 'beats') {
    case 'never':
      return false;
    case 'always':
    case 'mutual':
      return true;
    default:
      return beatsSet(spec).has(`${attacker}>${defender}`);
  }
};

/**
 * The rank a side starts behind.
 *
 * Blue's home is rank 1 and Red's is the last, which is the orientation every
 * board, record and coordinate in this project already uses. Reaching the
 * *opponent's* home is what Infiltration is won by, and stating it this way is
 * why that rule needs no board size in it.
 */
const homeRow = (spec: RuleSpec, side: SideColor) =>
  side === 'Blue' ? 0 : spec.board.height - 1;

/** Which concrete colour a rule means, from where the mover is standing. */
const resolveSide = (ref: SideRef, mover: SideColor): PlayerColor | 'any' => {
  switch (ref) {
    case 'mover':
      return mover;
    case 'opponent':
      return opposingColor(mover);
    case 'red':
      return 'Red';
    case 'blue':
      return 'Blue';
    case 'neutral':
      return 'Neutral';
    default:
      return 'any';
  }
};

const sideMatches = (ref: SideRef, actual: PlayerColor, mover: SideColor) => {
  const wanted = resolveSide(ref, mover);
  return wanted === 'any' || wanted === actual;
};

/* --------------------------------------------------------------- directions -- */

const ALL8: [number, number][] = [
  [-1, -1],
  [0, -1],
  [1, -1],
  [-1, 0],
  [1, 0],
  [-1, 1],
  [0, 1],
  [1, 1],
];
const ORTHOGONAL: [number, number][] = [
  [0, -1],
  [-1, 0],
  [1, 0],
  [0, 1],
];
const DIAGONAL: [number, number][] = [
  [-1, -1],
  [1, -1],
  [-1, 1],
  [1, 1],
];
const SIDEWAYS: [number, number][] = [
  [-1, 0],
  [1, 0],
];

/**
 * Which way a mover's "forward" points.
 *
 * Blue starts on rank 1 and advances up the ranks; Red starts on the last and
 * advances down. So one rule written `forward` serves both sides, which is the
 * whole reason the named sets are relative rather than absolute.
 */
const forwardStep = (mover: SideColor) => (mover === 'Blue' ? 1 : -1);

const directionsFor = (dirs: Directions, mover: SideColor): [number, number][] => {
  const forward = forwardStep(mover);
  if (typeof dirs !== 'string') {
    // Explicit offsets are in the mover's own frame: `+y` is forward, away from
    // your own home. A one-way piece is therefore one rule rather than two, and
    // a symmetric set — a knight's eight — reads the same either way.
    return dirs.offsets.map(([dx, dy]) => [dx, dy * forward] as [number, number]);
  }
  switch (dirs) {
    case 'orthogonal':
      return ORTHOGONAL;
    case 'diagonal':
      return DIAGONAL;
    case 'sideways':
      return SIDEWAYS;
    case 'forward':
      return [[0, forward]];
    case 'forwardDiagonal':
      return [
        [-1, forward],
        [1, forward],
      ];
    case 'backward':
      return [[0, -forward]];
    default:
      return ALL8;
  }
};

/* ---------------------------------------------------------------- generation -- */

/**
 * One legal move, with what produced it.
 *
 * `jumped` is the square whose piece a `jumpOver` move takes — not the square it
 * landed on. Carried from generation rather than worked out again at apply time,
 * because a step and a jump can reach the same square and only one of them takes
 * anything on the way.
 */
export interface SpecMove {
  from: Position;
  to: Position;
  jumped?: Position;
  /** True when the rule that produced this move demands a capture. */
  forcing: boolean;
}

const pieceAt = (grid: Grid, position: Position): Tile | null =>
  isOnBoard(grid, position) ? (grid[position.y]?.[position.x] ?? null) : null;

const ruleApplies = (rule: MovementRule, kind: PlayablePiece) => {
  if (rule.piece === undefined) return true;
  return Array.isArray(rule.piece) ? rule.piece.includes(kind) : rule.piece === kind;
};

/**
 * Whether a piece may finish on a square, ignoring how it got there.
 *
 * A friendly piece is never a destination — the one rule every mode inherits
 * without saying so, and the same refusal `standardRPSRules.validateMove` makes.
 */
const canLandOn = (
  spec: RuleSpec,
  destination: Tile,
  mover: SideColor,
  moving: PlayablePiece,
  targets: MovementRule['targets'],
): boolean => {
  const wanted = targets ?? 'any';
  if (destination.occupantOwner === mover) return false;
  if (destination.occupant === 'Empty') return wanted !== 'enemy';
  if (wanted === 'empty') return false;
  return specCanCapture(spec, moving, destination.occupant);
};

const destinationsForRule = (
  spec: RuleSpec,
  grid: Grid,
  rule: MovementRule,
  from: Position,
  mover: SideColor,
  moving: PlayablePiece,
): SpecMove[] => {
  const moves: SpecMove[] = [];
  const forcing = rule.mustCapture === true;
  const add = (to: Position, jumped?: Position) => {
    moves.push(jumped ? { from, to, jumped, forcing } : { from, to, forcing });
  };

  for (const [dx, dy] of directionsFor(rule.dirs, mover)) {
    if (rule.kind === 'slide') {
      const limit = rule.maxDistance ?? Math.max(boardWidth(grid), boardHeight(grid));
      for (let step = 1; step <= limit; step += 1) {
        const to = { x: from.x + dx * step, y: from.y + dy * step };
        const tile = pieceAt(grid, to);
        if (!tile) break;
        if (tile.occupant !== 'Empty') {
          // The ray stops here either way; it only ends *on* this square when
          // the piece standing there can be taken.
          if (canLandOn(spec, tile, mover, moving, rule.targets)) add(to);
          break;
        }
        if (canLandOn(spec, tile, mover, moving, rule.targets)) add(to);
      }
      continue;
    }

    if (rule.kind === 'jumpOver') {
      const over = { x: from.x + dx, y: from.y + dy };
      const jumpedTile = pieceAt(grid, over);
      if (!jumpedTile || jumpedTile.occupant === 'Empty') continue;
      const to = { x: from.x + dx * 2, y: from.y + dy * 2 };
      const landing = pieceAt(grid, to);
      // Checkers, not chess: you land on empty ground beyond the piece.
      if (!landing || landing.occupant !== 'Empty') continue;
      if ((rule.targets ?? 'any') === 'enemy') continue;
      const takes =
        rule.captureJumped === true &&
        jumpedTile.occupantOwner !== mover &&
        jumpedTile.occupant !== 'Empty' &&
        specCanCapture(spec, moving, jumpedTile.occupant);
      add(to, takes ? over : undefined);
      continue;
    }

    // `step` scales the direction; `leap` uses the offset as it stands. On the
    // named sets the two are the same thing at distance 1, which is the standard
    // king move.
    const distance = rule.kind === 'step' ? (rule.distance ?? 1) : 1;
    const to = { x: from.x + dx * distance, y: from.y + dy * distance };
    const tile = pieceAt(grid, to);
    if (tile && canLandOn(spec, tile, mover, moving, rule.targets)) add(to);
  }
  return moves;
};

const movesFromSquare = (
  spec: RuleSpec,
  game: PositionLike,
  from: Position,
): SpecMove[] => {
  const source = pieceAt(game.grid, from);
  if (!source || source.occupant === 'Empty') return [];
  if (source.occupantOwner !== game.currentTurn) return [];
  const mover = source.occupantOwner;
  if (mover !== 'Red' && mover !== 'Blue') return [];

  const moves: SpecMove[] = [];
  for (const rule of spec.movement) {
    if (!ruleApplies(rule, source.occupant)) continue;
    for (const move of destinationsForRule(spec, game.grid, rule, from, mover, source.occupant)) {
      if (rule.when !== undefined) {
        // A movement rule's condition is asked *before* the move, with both
        // squares known — the move has not happened yet. Everywhere else a
        // condition is asked after. `docs/rulespec.md` says so out loud, because
        // it is the one place the language is not uniform.
        const context = contextFor(spec, game, move, mover, source.occupant, false);
        if (!evaluate(rule.when, context)) continue;
      }
      moves.push(move);
    }
  }
  return dedupe(moves);
};

/**
 * Two rules reaching the same square give one move, and a jump wins the tie.
 *
 * Without this a piece that can both step and jump to a square would offer it
 * twice, and `applyMove` would have to pick. Preferring the jump is the useful
 * answer: it is the move that does something, and a mode whose author wanted
 * both spellings would have written two destinations.
 */
const dedupe = (moves: SpecMove[]): SpecMove[] => {
  const best = new Map<string, SpecMove>();
  for (const move of moves) {
    const key = `${move.to.x}:${move.to.y}`;
    const existing = best.get(key);
    if (!existing || (!existing.jumped && move.jumped) || (!existing.forcing && move.forcing)) {
      best.set(key, move);
    }
  }
  return [...best.values()];
};

/** Whether any rule in this mode can force a capture at all. */
const hasForcingRule = (spec: RuleSpec) => spec.movement.some((rule) => rule.mustCapture === true);

/**
 * Every move the side to move may play.
 *
 * `mustCapture` is why this is the primitive and one square's moves are derived
 * from it: a forced capture is a fact about the whole position, not about the
 * piece you happen to have selected. Modes without a forcing rule — which is
 * almost all of them — never pay for that, because `specMovesFor` short-circuits.
 */
export const specAllMoves = (spec: RuleSpec, game: PositionLike): SpecMove[] => {
  const moves: SpecMove[] = [];
  for (const row of game.grid) {
    for (const tile of row) {
      if (tile.occupantOwner !== game.currentTurn) continue;
      moves.push(...movesFromSquare(spec, game, { x: tile.x, y: tile.y }));
    }
  }
  return applyForcing(moves);
};

const applyForcing = (moves: SpecMove[]): SpecMove[] => {
  const forced = moves.filter((move) => move.forcing);
  return forced.length > 0 ? forced : moves;
};

/** The squares one piece may move to, whoever's turn it is. */
export const specMovesFor = (spec: RuleSpec, game: PositionLike, from: Position): Position[] => {
  if (!hasForcingRule(spec)) return movesFromSquare(spec, game, from).map((move) => move.to);
  return specAllMoves(spec, game)
    .filter((move) => samePosition(move.from, from))
    .map((move) => move.to);
};

/* --------------------------------------------------------------- evaluation -- */

/**
 * Everything a condition can ask about.
 *
 * One value carried through terms, filters, regions and predicates alike, so
 * "the square it landed on" means the same thing in a win condition as in an
 * effect. `grid` is the board the question is being asked about, which is
 * *after* the move everywhere except a movement rule's own `when`.
 */
interface EvalContext {
  spec: RuleSpec;
  grid: Grid;
  mover: SideColor;
  from: Position;
  to: Position;
  captured: boolean;
  moved: PlayablePiece;
  moveNumber: number;
}

const contextFor = (
  spec: RuleSpec,
  game: PositionLike,
  move: SpecMove,
  mover: SideColor,
  moved: PlayablePiece,
  captured: boolean,
): EvalContext => ({
  spec,
  grid: game.grid,
  mover,
  from: move.from,
  to: move.to,
  captured,
  moved,
  moveNumber: game.moveNumber,
});

const inRegion = (region: Region, position: Position, context: EvalContext): boolean => {
  const { spec, grid, mover } = context;
  if ('rows' in region) return region.rows.includes(position.y);
  if ('columns' in region) return region.columns.includes(position.x);
  if ('squares' in region) {
    return region.squares.some(([x, y]) => x === position.x && y === position.y);
  }
  if ('rect' in region) {
    const { x, y, width, height } = region.rect;
    return (
      position.x >= x && position.x < x + width && position.y >= y && position.y < y + height
    );
  }
  if ('home' in region) {
    const side =
      region.home === 'mover'
        ? mover
        : region.home === 'opponent'
          ? opposingColor(mover)
          : region.home === 'red'
            ? 'Red'
            : 'Blue';
    return position.y === homeRow(spec, side);
  }
  if ('corners' in region) {
    const lastColumn = boardWidth(grid) - 1;
    const lastRow = boardHeight(grid) - 1;
    return (
      (position.x === 0 || position.x === lastColumn) &&
      (position.y === 0 || position.y === lastRow)
    );
  }
  if ('edge' in region) {
    return (
      position.x === 0 ||
      position.y === 0 ||
      position.x === boardWidth(grid) - 1 ||
      position.y === boardHeight(grid) - 1
    );
  }
  if ('destination' in region) return samePosition(position, context.to);
  if ('origin' in region) return samePosition(position, context.from);
  return true;
};

const matchesFilter = (filter: TileFilter, tile: Tile, context: EvalContext): boolean => {
  if (filter.region && !inRegion(filter.region, { x: tile.x, y: tile.y }, context)) return false;
  if (filter.empty !== undefined && (tile.occupant === 'Empty') !== filter.empty) return false;
  if (filter.owner !== undefined && !sideMatches(filter.owner, tile.occupantOwner, context.mover)) {
    return false;
  }
  if (filter.territory !== undefined && !sideMatches(filter.territory, tile.ownerColor, context.mover)) {
    return false;
  }
  if (filter.piece !== undefined) {
    const kinds = Array.isArray(filter.piece) ? filter.piece : [filter.piece];
    if (!kinds.includes(tile.occupant)) return false;
  }
  return true;
};

const tilesMatching = (filter: TileFilter, context: EvalContext): Tile[] => {
  const found: Tile[] = [];
  for (const row of context.grid) {
    for (const tile of row) {
      if (matchesFilter(filter, tile, context)) found.push(tile);
    }
  }
  return found;
};

const evalTerm = (term: Term, context: EvalContext): number => {
  if (typeof term === 'number') return term;
  if ('count' in term) return tilesMatching(term.count, context).length;
  if ('row' in term) return term.row === 'to' ? context.to.y : context.from.y;
  if ('column' in term) return term.column === 'to' ? context.to.x : context.from.x;
  if ('moveNumber' in term) return context.moveNumber;
  // A share is territory as a fraction of the whole board, so a mode can say
  // "hold two thirds of it" without knowing how big the board is.
  const tiles = boardWidth(context.grid) * boardHeight(context.grid);
  if (tiles === 0) return 0;
  return tilesMatching({ territory: term.share }, context).length / tiles;
};

const evaluate = (predicate: Predicate, context: EvalContext): boolean => {
  if (typeof predicate === 'boolean') return predicate;
  if ('and' in predicate) return predicate.and.every((item) => evaluate(item, context));
  if ('or' in predicate) return predicate.or.some((item) => evaluate(item, context));
  if ('not' in predicate) return !evaluate(predicate.not, context);
  if ('eq' in predicate) {
    return evalTerm(predicate.eq[0], context) === evalTerm(predicate.eq[1], context);
  }
  if ('lt' in predicate) {
    return evalTerm(predicate.lt[0], context) < evalTerm(predicate.lt[1], context);
  }
  if ('lte' in predicate) {
    return evalTerm(predicate.lte[0], context) <= evalTerm(predicate.lte[1], context);
  }
  if ('gt' in predicate) {
    return evalTerm(predicate.gt[0], context) > evalTerm(predicate.gt[1], context);
  }
  if ('gte' in predicate) {
    return evalTerm(predicate.gte[0], context) >= evalTerm(predicate.gte[1], context);
  }
  if ('in' in predicate) {
    const [which, region] = predicate.in;
    return inRegion(region, which === 'to' ? context.to : context.from, context);
  }
  if ('captured' in predicate) return context.captured;
  if ('moved' in predicate) {
    const kinds = Array.isArray(predicate.moved) ? predicate.moved : [predicate.moved];
    return kinds.includes(context.moved);
  }
  if ('any' in predicate) {
    const tiles = tilesMatching(predicate.any.tiles, context);
    const where = predicate.any.where;
    return where === undefined ? tiles.length > 0 : tiles.some(() => evaluate(where, context));
  }
  const tiles = tilesMatching(predicate.all.tiles, context);
  const where = predicate.all.where;
  return where === undefined ? tiles.length > 0 : tiles.every(() => evaluate(where, context));
};

/* -------------------------------------------------------------------- apply -- */

/** Threefold, the same number `game.Game` uses. Not a spec's to change. */
const REPETITION_LIMIT = 3;

const cloneGrid = (grid: Grid): Grid => grid.map((row) => row.map((tile) => ({ ...tile })));

const clearTile = (tile: Tile) => {
  tile.occupant = 'Empty';
  tile.occupantOwner = 'Neutral';
};

/** Run one effect over the board the move has already been made on. */
const runEffect = (effect: Effect, context: EvalContext): { extraTurn: boolean } => {
  const { grid, mover, to } = context;
  const destination = grid[to.y]?.[to.x];

  if ('claimTerritory' in effect) {
    // Claims ground nobody holds, and only that. Taking ground somebody already
    // owns is `setTerritory` over the `destination` region — a different rule,
    // and visible as one in the spec rather than hidden behind a flag. This is
    // exactly what `mode_total_war.go` does.
    const side = resolveSide(effect.claimTerritory, mover);
    if (destination && destination.ownerColor === 'Neutral' && side !== 'any') {
      destination.ownerColor = side;
    }
    return { extraTurn: false };
  }
  if ('setTerritory' in effect) {
    const side = resolveSide(effect.setTerritory.to, mover);
    if (side !== 'any') {
      for (const tile of tilesMatching(effect.setTerritory.tiles, context)) {
        grid[tile.y]![tile.x]!.ownerColor = side;
      }
    }
    return { extraTurn: false };
  }
  if ('promote' in effect) {
    if (destination && destination.occupant !== 'Empty') {
      destination.occupant = effect.promote.to;
    }
    return { extraTurn: false };
  }
  if ('remove' in effect) {
    for (const tile of tilesMatching(effect.remove.tiles, context)) {
      clearTile(grid[tile.y]![tile.x]!);
    }
    return { extraTurn: false };
  }
  if ('spawn' in effect) {
    const owner = resolveSide(effect.spawn.owner, mover);
    if (owner === 'Red' || owner === 'Blue') {
      // The first empty square of the region, in board order, so a spawn is
      // reproducible rather than a choice the interpreter makes differently
      // from the server's.
      for (const row of grid) {
        for (const tile of row) {
          if (tile.occupant !== 'Empty') continue;
          if (!inRegion(effect.spawn.at, { x: tile.x, y: tile.y }, context)) continue;
          tile.occupant = effect.spawn.piece;
          tile.occupantOwner = owner;
          return { extraTurn: false };
        }
      }
    }
    return { extraTurn: false };
  }
  return { extraTurn: true };
};

const resolveWin = (
  result: WinResult,
  context: EvalContext,
): { winner: PlayerColor } => {
  if (result === 'mover') return { winner: context.mover };
  if (result === 'opponent') return { winner: opposingColor(context.mover) };
  if (result === 'draw') return { winner: 'Neutral' };
  const red = evalTerm(result.moreOf.red, context);
  const blue = evalTerm(result.moreOf.blue, context);
  if (red === blue) return { winner: 'Neutral' };
  return { winner: red > blue ? 'Red' : 'Blue' };
};

/**
 * Play a move, or `null` when it is not legal from this position.
 *
 * The order below is the server's order, and every step of it is load-bearing:
 * the piece moves, then the mode's effects run, then its win conditions are
 * checked, and only a game still in progress passes the turn. `mode_total_war.go`
 * returns before `passTurn` for exactly this reason, which is why a decided
 * game's final position still has the winner to move — visible in every archived
 * record's `FinalFEN`, and replayed by the review.
 */
export const specApplyMove = (
  spec: RuleSpec,
  game: AnalysisGame,
  from: Position,
  to: Position,
): AppliedMove | null => {
  if (game.status !== 'InProgress') return null;
  const mover = game.currentTurn;
  if (mover !== 'Red' && mover !== 'Blue') return null;

  const legal = (hasForcingRule(spec) ? specAllMoves(spec, game) : movesFromSquare(spec, game, from))
    .find((move) => samePosition(move.from, from) && samePosition(move.to, to));
  if (!legal) return null;

  const source = game.grid[from.y]?.[from.x];
  if (!source || source.occupant === 'Empty') return null;
  const moved = source.occupant;

  const grid = cloneGrid(game.grid);
  const start = grid[from.y]![from.x]!;
  const destination = grid[to.y]![to.x]!;
  const jumpedTile = legal.jumped ? grid[legal.jumped.y]![legal.jumped.x]! : null;

  const takesDestination = destination.occupant !== 'Empty';
  const mutuallyDestroyed =
    takesDestination &&
    spec.capture?.mode === 'mutual' &&
    // Mutual destruction, except where the graph already says this attacker wins
    // the exchange outright.
    !beatsSet(spec).has(`${moved}>${destination.occupant}`);
  const captured = takesDestination || jumpedTile !== null;

  destination.occupant = moved;
  destination.occupantOwner = mover;
  clearTile(start);
  if (jumpedTile) clearTile(jumpedTile);
  if (mutuallyDestroyed) clearTile(destination);

  const next: AnalysisGame = {
    ...game,
    currentTurn: opposingColor(mover),
    grid,
    moveNumber: game.moveNumber + 1,
  };
  const context: EvalContext = {
    spec,
    grid,
    mover,
    from,
    to,
    captured,
    moved,
    moveNumber: next.moveNumber,
  };

  let extraTurn = false;
  for (const rule of spec.effects ?? []) {
    if (rule.on === 'capture' && !captured) continue;
    if (rule.when !== undefined && !evaluate(rule.when, context)) continue;
    for (const effect of rule.do) {
      if (runEffect(effect, context).extraTurn) extraTurn = true;
    }
  }

  // A mode that ends the game on a move never passes the turn.
  const decide = (winner: PlayerColor, reason: string) => {
    next.status = 'Finished';
    next.winner = winner;
    next.endReason = reason as AnalysisGame['endReason'];
    next.currentTurn = mover;
  };

  for (const condition of spec.win) {
    if (!evaluate(condition.when, context)) continue;
    decide(resolveWin(condition.result, context).winner, condition.reason ?? 'game_rule');
    break;
  }

  if (next.status === 'InProgress') {
    // `movesPerTurn` passes the turn every nth move rather than every move, and
    // `extraTurn` overrides it outright. Both are counted off `moveNumber`, so a
    // replay lands on the same side to move as the game did.
    const perTurn = spec.turn?.movesPerTurn ?? 1;
    const passes = !extraTurn && next.moveNumber % perTurn === 0;
    next.currentTurn = passes ? opposingColor(mover) : mover;
  }

  // Stalemate and repetition are the engine's, not the mode's, and no spec can
  // change them. They are applied here because there is no engine on this side —
  // `Game` in the backend does exactly this, after the turn has changed hands,
  // which is why both keep it changed.
  if (next.status === 'InProgress' && !hasAnyMove(spec, next)) {
    next.status = 'Finished';
    next.winner = 'Neutral';
    next.endReason = 'stalemate';
  }

  const key = positionKey(next.grid, next.currentTurn);
  next.repetitionHistory = [
    ...(game.repetitionHistory ?? [positionKey(game.grid, game.currentTurn)]),
    key,
  ];
  if (
    next.status === 'InProgress' &&
    next.repetitionHistory.filter((candidate) => candidate === key).length >= REPETITION_LIMIT
  ) {
    next.status = 'Finished';
    next.winner = 'Neutral';
    next.endReason = 'repetition';
  }

  const moveLimit = spec.draw?.moveLimit;
  if (next.status === 'InProgress' && moveLimit != null && next.moveNumber >= moveLimit) {
    next.status = 'Finished';
    next.winner = 'Neutral';
    next.endReason = 'move_limit';
  }

  return { captured, game: next, mover };
};

const hasAnyMove = (spec: RuleSpec, game: PositionLike): boolean => {
  for (const row of game.grid) {
    for (const tile of row) {
      if (tile.occupantOwner !== game.currentTurn) continue;
      if (movesFromSquare(spec, game, { x: tile.x, y: tile.y }).length > 0) return true;
    }
  }
  return false;
};

/* --------------------------------------------------------------------- mode -- */

/**
 * A spec as the catalogue entry every screen already knows how to read.
 *
 * The board, the lobby, the review and the analysis screen all take a
 * `ModeDefinition`; a spec-defined mode becomes one here rather than each of
 * them learning what a spec is. `features` is derived rather than declared,
 * because a mode has territory exactly when something in it claims ground —
 * asking the rules is one fact, and a flag beside them would be a second one
 * that can disagree.
 */
export const modeDefinitionFor = (
  spec: RuleSpec,
  id: string,
  origin: 'builtin' | 'community' = 'community',
): ModeDefinition => ({
  id,
  shortCode: spec.shortCode,
  name: spec.name,
  description: spec.description,
  objective: spec.objective,
  displayOrder: 0,
  playable: true,
  features: claimsTerritory(spec) ? ['territory'] : [],
  startingPosition: spec.startingPosition,
  spec,
  origin,
});

/**
 * The letters this mode's layouts are written with, from its own piece list.
 *
 * Upper case is Blue and lower case is Red — the same convention the built-in
 * modes use, so a spec that happens to declare `R` for Rock spells its opening
 * exactly as Total War always has.
 */
export const alphabetFor = (spec: RuleSpec): PieceAlphabet => {
  const alphabet: PieceAlphabet = {};
  for (const piece of spec.pieces) {
    const upper = piece.symbol.toUpperCase();
    alphabet[upper] = { occupant: piece.id, occupantOwner: 'Blue' };
    alphabet[upper.toLowerCase()] = { occupant: piece.id, occupantOwner: 'Red' };
  }
  return alphabet;
};

/**
 * How each kind is drawn, keyed by the value on the tile.
 *
 * Two things travel together because a board needs both and needs them for the
 * same kind: the artwork to paint, and the letter to fall back to when there is
 * none. The letter is the mode's `symbol` rather than the kind's initial,
 * because `symbol` is unique within a mode and an initial is not — a mode with
 * Scissors and Spock in it has two kinds beginning with S and exactly one way to
 * tell them apart.
 *
 * `art` is the whole reason this is not just a letter table. A kind is drawn by
 * what its author said it looks like, not by what it is called, so a Boulder
 * that declares `art: "rock"` gets the rock, and a mode that renames all three
 * standard kinds still draws as the game it plainly is.
 */
export const looksFor = (spec: RuleSpec): Record<string, PieceLook> =>
  Object.fromEntries(
    spec.pieces.map((piece) => [
      piece.id,
      { symbol: piece.symbol.toUpperCase(), art: piece.art },
    ]),
  );

const claimsTerritory = (spec: RuleSpec) =>
  (spec.effects ?? []).some((rule) =>
    rule.do.some((effect) => 'claimTerritory' in effect || 'setTerritory' in effect),
  );
