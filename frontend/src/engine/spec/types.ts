// A game mode as data.
//
// One versioned JSON document is the whole artifact: what the agent in the RPS
// Lab edits, what gets published to the library, what travels inside a
// `ModeDefinition` to every client, and what both interpreters read — the
// TypeScript one in `interpret.ts` and the Go one in
// `backend/internal/game/spec`. `docs/rulespec.md` is the reference written for
// a reader; this file is the same language written for the compiler, and the
// two are expected to change together.
//
// Three properties are deliberate and worth stating before the types:
//
//  1. **Data, never code.** The server is authoritative for online play, so
//     whatever a spec says has to be executable by Go with no sandbox, no
//     timeout and no untrusted execution. Nothing here is a function.
//  2. **Total by construction.** Every list is finite, every predicate is a
//     bounded scan of the board, and nothing recurses into itself without
//     shrinking. So the cost of evaluating a spec is bounded by the board and
//     the spec's own length, which is what makes it safe to run for a stranger.
//  3. **Open by composition, not by enumeration.** Every slot is a list and
//     every entry can carry a `when`, so the reachable space is not a menu.
//     A new kind of rule is a new *combination* far more often than it is a new
//     field, and that is the property the Lab's agent is relying on.

import type { StartingPosition } from '@/types/game';

/**
 * The language version, bumped only for a change a v1 interpreter could not
 * read correctly. A published spec is immutable and carries its own version, so
 * an old mode keeps meaning what it meant.
 */
export const SPEC_VERSION = 1;

/* ------------------------------------------------------------------ pieces -- */

/**
 * One kind of piece.
 *
 * `id` is what the rest of the spec refers to. `symbol` is the single letter it
 * is written with in a layout and in the archive's FEN — upper case for Blue and
 * lower for Red, so the standard modes spell `R`/`r` exactly as they always
 * have. `art` names bundled artwork or an uploaded image; a kind with none is
 * drawn as its letter, which is what lets an author invent a piece without
 * drawing one.
 */
export interface PieceKindSpec {
  id: string;
  name: string;
  /** One letter, `A`–`Z`. Case is the side, so this is the upper-case form. */
  symbol: string;
  /** A bundled name (`PieceArt`) or an uploaded image (`ArtRef`). */
  art?: string;
}

/** The bundled artwork a kind may borrow, whatever the kind is called. */
export type PieceArt = 'rock' | 'paper' | 'scissors';

export const PIECE_ART: readonly PieceArt[] = ['rock', 'paper', 'scissors'];

/**
 * A reference to an uploaded image: `img:` and the first 128 bits of the
 * asset's SHA-256, lower case.
 *
 * The picture itself lives on the server and is fetched by id, because a spec
 * is capped at `MAX_SPEC_BYTES` and an image is not going to fit in it. The
 * digest *is* the address, which is what makes an asset immutable — the same
 * property a published mode has, arrived at the same way.
 *
 * An older reader does not know this form and warns rather than failing, so a
 * mode carrying one still plays; its pieces are simply drawn as letters. That
 * is the whole reason `art` is a plain string and not a union: the format could
 * grow a third kind of value tomorrow and nothing already published breaks.
 */
export const ART_REF_PATTERN = /^img:[0-9a-f]{32}$/;

/** Whether a value addresses an uploaded image. */
export const isArtRef = (value: string): boolean => ART_REF_PATTERN.test(value);

/**
 * Who takes whom, as a directed graph: `[attacker, defender]`.
 *
 * A graph rather than a cycle. The standard game is the three-cycle
 * `rock→scissors→paper→rock`, but nothing here requires that shape, so
 * Rock-Paper-Scissors-Lizard-Spock, one-sided matchups and a kind nothing can
 * capture are all sayable. `validate.ts` warns about a kind with no predator,
 * because it makes an annihilation win unreachable.
 */
export type BeatsEdge = [attacker: string, defender: string];

/* ---------------------------------------------------------------- geometry -- */

/**
 * A set of directions.
 *
 * The names cover what almost every mode wants; `offsets` is the escape hatch
 * for the ones they do not, and is what a knight's move or a one-way piece is
 * written with. `forward` is relative to the mover: away from their own home
 * boundary, so one rule serves both sides.
 */
export type Directions =
  | 'all8'
  | 'orthogonal'
  | 'diagonal'
  | 'forward'
  | 'forwardDiagonal'
  | 'backward'
  | 'sideways'
  | { offsets: [dx: number, dy: number][] };

/** What a movement rule may land on. */
export type MoveTargets = 'empty' | 'enemy' | 'any';

/**
 * One way a piece may move. A mode's `movement` is the union of these, so two
 * rules for the same kind give it both.
 *
 *  - `step`   — a fixed distance in a direction, ignoring nothing in between
 *               (distance 1 is the standard king step).
 *  - `slide`  — any distance up to `maxDistance`, stopped by an occupied square.
 *  - `leap`   — straight to an offset, whatever stands between (a knight).
 *  - `jumpOver` — the checkers move: over the adjacent piece to the square
 *               beyond, optionally taking what was jumped. This is the shape the
 *               reusable `jump` part is built from.
 */
export type MovementRule = (
  | { kind: 'step'; dirs: Directions; distance?: number }
  | { kind: 'slide'; dirs: Directions; maxDistance?: number }
  | { kind: 'leap'; dirs: Directions }
  | { kind: 'jumpOver'; dirs: Directions; captureJumped?: boolean }
) & {
  /** The kinds this applies to. Absent means every kind. */
  piece?: string | string[];
  targets?: MoveTargets;
  /** Only legal when this holds. */
  when?: Predicate;
  /** When any move satisfying this rule exists, only such moves are legal. */
  mustCapture?: boolean;
};

/* ----------------------------------------------------------------- regions -- */

/**
 * A named set of squares.
 *
 * `home` is the rank a side starts behind — Blue's is rank 1 and Red's is the
 * last — so "reach the opponent's home" is one region rather than two rules with
 * a board size in them.
 */
export type Region =
  | { rows: number[] }
  | { columns: number[] }
  | { squares: [x: number, y: number][] }
  | { rect: { x: number; y: number; width: number; height: number } }
  | { home: 'mover' | 'opponent' | 'red' | 'blue' }
  /** The square the move just played landed on. */
  | { destination: true }
  /** The square it came from. */
  | { origin: true }
  | { corners: true }
  | { edge: true }
  | { all: true };

/* ---------------------------------------------------------------- the term -- */

/** Which side a filter or a term is asking about, relative to the mover. */
export type SideRef = 'mover' | 'opponent' | 'red' | 'blue' | 'neutral' | 'any';

/** Which squares a `count` counts. */
export interface TileFilter {
  region?: Region;
  /** Tiles holding a piece of this side. */
  owner?: SideRef;
  /** Tiles holding one of these kinds. */
  piece?: string | string[];
  /** Tiles whose *territory* belongs to this side. */
  territory?: SideRef;
  /** Tiles with no piece on them. */
  empty?: boolean;
}

/**
 * A number the rules can talk about.
 *
 * Deliberately few, and every one of them cheap: a literal, a count of tiles, a
 * coordinate of the move just played, or the move number. Anything a mode wants
 * to compare is one of these on each side of a comparison.
 */
export type Term =
  | number
  | { count: TileFilter }
  | { row: 'from' | 'to' }
  | { column: 'from' | 'to' }
  | { moveNumber: true }
  /** The territory a side holds, as a share of the board from 0 to 1. */
  | { share: SideRef };

/**
 * A question with a yes-or-no answer, over the position after the move.
 *
 * `in` is membership: a square in a region. `any`/`all` are the only
 * quantifiers, and both scan a filtered set of tiles once, so a predicate costs
 * at most one pass over the board per quantifier it contains.
 */
export type Predicate =
  | boolean
  | { and: Predicate[] }
  | { or: Predicate[] }
  | { not: Predicate }
  | { eq: [Term, Term] }
  | { lt: [Term, Term] }
  | { lte: [Term, Term] }
  | { gt: [Term, Term] }
  | { gte: [Term, Term] }
  /** The square a piece moved from or to, inside a region. */
  | { in: ['from' | 'to', Region] }
  /** The move just played took something. */
  | { captured: true }
  /** The piece that moved is one of these kinds. */
  | { moved: string | string[] }
  | { any: { tiles: TileFilter; where?: Predicate } }
  | { all: { tiles: TileFilter; where?: Predicate } };

/* ----------------------------------------------------------------- effects -- */

/**
 * Something a move does to the board beyond moving the piece.
 *
 * Total War's territory is `claimTerritory`, which is the whole of what makes it
 * a different game from Infiltration — so the effects list is where a mode's
 * character usually lives.
 */
export type Effect =
  /**
   * Claim the square just landed on, if nobody owns it yet. This is Total War's
   * whole territory rule. Deliberately does not take ground somebody already
   * holds — `setTerritory` over the `destination` region is how a mode says
   * that instead, so the difference is visible in the spec rather than hidden in
   * a flag.
   */
  | { claimTerritory: SideRef }
  | { setTerritory: { tiles: TileFilter; to: SideRef } }
  | { promote: { to: string } }
  | { remove: { tiles: TileFilter } }
  | { spawn: { piece: string; owner: SideRef; at: Region } }
  /** The mover goes again instead of passing the turn. */
  | { extraTurn: true };

export interface EffectRule {
  on: 'move' | 'capture' | 'turnEnd';
  when?: Predicate;
  do: Effect[];
}

/* --------------------------------------------------------- win conditions -- */

/**
 * Who won, when a condition holds.
 *
 * `moreOf` is what "most territory wins" is written with, and it is why a
 * majority rule needs no special case: it compares two terms and hands the game
 * to whichever side is ahead, or calls it a draw when they are level.
 */
export type WinResult =
  | 'mover'
  | 'opponent'
  | 'draw'
  | { moreOf: { red: Term; blue: Term } };

/**
 * Checked in order after every move, and the first one that holds ends the game.
 *
 * Order is the tie-break, and it is load-bearing: Total War checks annihilation
 * before territory, so wiping out the last enemy piece on the square that fills
 * the board is a win rather than a count.
 */
export interface WinCondition {
  /** Names the rule, for `simulate`'s report of what never fired. */
  id?: string;
  when: Predicate;
  result: WinResult;
  /** The `endReason` a record stores. Falls back to `game_rule`. */
  reason?: string;
}

/* ------------------------------------------------------------------- rest -- */

export interface TurnSpec {
  /** Moves per turn. Defaults to 1. */
  movesPerTurn?: number;
  /** Whether a player with a legal move may decline to make one. */
  mayPass?: boolean;
}

/**
 * How contact resolves.
 *
 *  - `beats`  — the `beats` graph decides, which is the standard game.
 *  - `always` — anything takes anything, like chess.
 *  - `never`  — nothing is ever captured; the mode wins another way.
 *  - `mutual` — both pieces are removed unless the graph says otherwise.
 */
export interface CaptureSpec {
  mode: 'beats' | 'always' | 'never' | 'mutual';
}

/**
 * The one draw rule a mode gets to state.
 *
 * Threefold repetition and the stalemate draw are deliberately *not* here. Both
 * are engine-level and identical for every mode — `Game` in
 * `backend/internal/game` applies them without asking, which is what
 * `backend/docs/game-modes.md` means by "inherited" — so a spec that claimed to
 * change them would be making a promise the authoritative server could not keep.
 * The two readers would then agree with each other and disagree with the game.
 *
 * `moveLimit` is different: it depends only on the move number, so both readers
 * and the server can honour it identically.
 */
export interface DrawSpec {
  moveLimit?: number | null;
}

/* ------------------------------------------------------------------- spec -- */

export interface RuleSpec {
  spec: number;
  name: string;
  shortCode: string;
  description: string;
  objective: string;
  board: { width: number; height: number; art?: string };
  pieces: PieceKindSpec[];
  beats: BeatsEdge[];
  startingPosition: StartingPosition;
  turn?: TurnSpec;
  movement: MovementRule[];
  capture?: CaptureSpec;
  effects?: EffectRule[];
  win: WinCondition[];
  draw?: DrawSpec;
  /**
   * An image for the mode's card in the library, as an `ArtRef`.
   *
   * In the document rather than in the publish request, for the reason the name
   * is: the server reads a mode's name, code, description and objective out of
   * the spec because that document is what a live game carries and what a fork
   * starts from. A cover that lived only in the request would vanish the first
   * time somebody forked the mode.
   */
  cover?: string;
}

/* ------------------------------------------------------------------ parts -- */

/**
 * A published, parameterised fragment of one slot — the reuse unit.
 *
 * A spec refers to one as `{ use: 'jump@1', with: {...} }`, and the resolver
 * substitutes `$name` in the body with the argument before **inlining it**. So a
 * published mode is self-contained: it never breaks when the part's author edits
 * theirs, and playing it needs no lookup, which is what lets a whole spec ride
 * inside a `ModeDefinition` and reach a player who has never heard of the mode.
 * `derivedFrom` is what the library shows as provenance.
 */
export interface RulePart {
  part: number;
  id: string;
  version: number;
  author?: string;
  kind: 'movement' | 'capture' | 'effect' | 'win' | 'draw' | 'turn';
  name: string;
  summary: string;
  params?: Record<string, { type: 'boolean' | 'number' | 'string'; default?: unknown }>;
  body: unknown;
}

/** A reference to a part, which may appear anywhere its slot's own entry may. */
export interface PartUse {
  use: string;
  with?: Record<string, unknown>;
}

export const isPartUse = (value: unknown): value is PartUse =>
  typeof value === 'object' && value !== null && typeof (value as PartUse).use === 'string';
