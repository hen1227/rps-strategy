// Where one movement rule can actually go.
//
// The MOVES tab could describe a rule in words — "slide, diagonal, up to 3" —
// and every author would still have to picture it. So it draws it instead: one
// piece on an empty board, and every square that rule alone can reach from the
// middle.
//
// It is answered by the interpreter rather than by reading the rule, which is
// the same bargain `lab_legal_moves` makes: the rules answering is the only
// answer that cannot disagree with the game. A rule that reaches nowhere shows
// as an empty board, which is exactly the fact worth seeing — it is the shape a
// movement rule takes when it is wrong.

import { createAnalysisGame, validMovesFor } from '@/engine/analysisGame';
import { modeDefinitionFor } from '@/engine/spec/interpret';
import type { RuleSpec } from '@/engine/spec/types';
import type { Position } from '@/types/game';

export interface MoveReach {
  /** The square the piece was put on. */
  from: Position;
  /** Every square this rule alone can reach from there. */
  to: Position[];
  /** The kind that was placed, so the preview can draw the right piece. */
  kindId: string;
  /** The board the preview is drawn on. Small: a rule is a local shape. */
  width: number;
  height: number;
}

/** A board big enough to show a slide and small enough to read at a glance. */
const PREVIEW_SIDE = 7;

const cache = new WeakMap<RuleSpec, Map<number, MoveReach | null>>();

/**
 * The kind a rule is about.
 *
 * A rule with no `piece` applies to every kind, so the first one stands for all
 * of them; a rule naming several is shown with the first it names, because the
 * shape is the same and one board is the point.
 */
const kindFor = (spec: RuleSpec, index: number): string | null => {
  const rule = spec.movement?.[index];
  const named = rule && 'piece' in rule ? rule.piece : undefined;
  const first = Array.isArray(named) ? named[0] : named;
  if (typeof first === 'string' && first) return first;
  return spec.pieces?.[0]?.id ?? null;
};

/**
 * One rule, on an empty board, from the middle.
 *
 * Built as a whole spec with `movement` narrowed to the single rule, so
 * everything else about the mode — its kinds, its capture rule, its board art —
 * is still true of the preview. Narrowing rather than synthesising is what keeps
 * this honest: it is the mode's own rule, read by the mode's own interpreter.
 *
 * Answers `null` rather than throwing when the spec cannot make a game at all.
 * A preview is a nicety and must never be the reason a page fails to draw.
 */
export const reachOf = (spec: RuleSpec, index: number): MoveReach | null => {
  const perSpec = cache.get(spec) ?? new Map<number, MoveReach | null>();
  if (!cache.has(spec)) cache.set(spec, perSpec);
  const cached = perSpec.get(index);
  if (cached !== undefined) return cached;

  const answer = compute(spec, index);
  perSpec.set(index, answer);
  return answer;
};

const compute = (spec: RuleSpec, index: number): MoveReach | null => {
  const rule = spec.movement?.[index];
  const kindId = kindFor(spec, index);
  if (!rule || !kindId) return null;

  const kind = spec.pieces?.find((piece) => piece.id === kindId);
  if (!kind) return null;

  const side = Math.min(
    PREVIEW_SIDE,
    Math.max(spec.board?.width ?? PREVIEW_SIDE, spec.board?.height ?? PREVIEW_SIDE),
  );
  const centre = { x: Math.floor(side / 2), y: Math.floor(side / 2) };
  // Upper case is Blue, and Blue is not the side to move — so the piece is
  // placed as Red, lower case, or nothing would be legal at all.
  const symbol = kind.symbol.toLowerCase();
  const rows = Array.from({ length: side }, (_unused, y) =>
    Array.from({ length: side }, (_unusedTile, x) =>
      x === centre.x && y === centre.y ? symbol : '.',
    ).join(''),
  );

  try {
    const narrowed: RuleSpec = {
      ...spec,
      board: { ...spec.board, width: side, height: side },
      movement: [rule],
      startingPosition: { rows },
      // A win condition that already holds on an empty board would end the game
      // before a single move was legal, and every square would read "unreachable"
      // for a reason that has nothing to do with this rule.
      win: [],
      draw: {},
    };
    const mode = modeDefinitionFor(narrowed, 'lab-move-preview');
    const game = createAnalysisGame(mode, { rows });
    return { from: centre, to: validMovesFor(game, centre), kindId, width: side, height: side };
  } catch {
    return null;
  }
};
