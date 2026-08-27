// A search that can play any mode.
//
// RPSFish plays the two shipped modes and nothing else: its boards are `u128`
// bitmaps over eighty-one squares and its pruning rests on the
// rock-paper-scissors three-cycle, so a mode with a Lizard on an eleven-wide
// board is not a mode it can be asked about. Somebody designing a game in the
// Lab still needs an opponent, and this is it.
//
// It is deliberately a general search rather than a good one. Plain negamax with
// alpha-beta over `interpret.ts`, an evaluation assembled from the spec itself,
// and no book, no table and no tuning — because there is nothing to tune it
// *for*: the mode it is playing did not exist when this was written. It is
// strong enough to find a mode's degenerate line, which is what a playtester
// needs, and it says so rather than pretending to be an engine.
//
// It is exposed as an `AnalyzeFn`, which is the point: `createBot` takes one, so
// the whole existing profile ladder — depths, `randomMoveChance`, manners,
// tempo — drives a custom mode without knowing anything has changed.

import { createAnalysisGameFrom, type AnalysisGame } from '../analysisGame';
import type { AnalyzeFn } from '../rpsfish/client';
import type { Analysis, EngineLine, StopReason } from '../rpsfish/protocol';
import { modeDefinitionFor, specAllMoves, specApplyMove, type SpecMove } from './interpret';
import type { RuleSpec } from './types';
import { boardHeight, boardWidth, type Grid, type Move, type SideColor } from '@/types/game';

/** Past this a score is a win rather than an advantage. */
const WIN_SCORE = 30_000;

export interface SpecSearchOptions {
  /** Ceiling on plies. The caller's `maxDepth` narrows it further. */
  maxDepth?: number;
  maxNodes?: number;
  maxTimeMs?: number;
}

const DEFAULTS = { maxDepth: 6, maxNodes: 250_000, maxTimeMs: 1_500 };

/* ------------------------------------------------------------- evaluation -- */

/**
 * What one piece of each kind is worth, from the capture graph alone.
 *
 * A kind that takes many and is taken by few is worth more, and a kind nothing
 * can take is worth a great deal — which is exactly right, and also exactly the
 * thing the validator warns about. Derived rather than configured because the
 * mode being valued did not exist when this was written; there is nobody to ask.
 */
const pieceValues = (spec: RuleSpec): Record<string, number> => {
  const kinds = spec.pieces.map((piece) => piece.id);
  const prey = new Map<string, number>();
  const predators = new Map<string, number>();
  for (const [attacker, defender] of spec.beats) {
    prey.set(attacker, (prey.get(attacker) ?? 0) + 1);
    predators.set(defender, (predators.get(defender) ?? 0) + 1);
  }
  const values: Record<string, number> = {};
  for (const kind of kinds) {
    const takes = prey.get(kind) ?? 0;
    const taken = predators.get(kind) ?? 0;
    // An untouchable piece is capped rather than infinite: it is still only one
    // piece, and letting it dominate the score makes the search ignore the game.
    const safety = taken === 0 ? 1.6 : 1 - taken / (kinds.length + 1);
    values[kind] = Math.round(100 * (0.6 + takes / (kinds.length + 1) + safety));
  }
  return values;
};

/** Whether any win condition talks about reaching a home rank. */
const racesHome = (spec: RuleSpec): boolean => {
  const mentionsHome = (value: unknown): boolean => {
    if (Array.isArray(value)) return value.some(mentionsHome);
    if (typeof value !== 'object' || value === null) return false;
    if ('home' in value) return true;
    return Object.values(value).some(mentionsHome);
  };
  return spec.win.some((condition) => mentionsHome(condition.when));
};

const claimsGround = (spec: RuleSpec) =>
  (spec.effects ?? []).some((rule) =>
    rule.do.some((effect) => 'claimTerritory' in effect || 'setTerritory' in effect),
  );

interface Weights {
  values: Record<string, number>;
  race: boolean;
  territory: boolean;
}

const weightsCache = new WeakMap<RuleSpec, Weights>();

const weightsFor = (spec: RuleSpec): Weights => {
  const cached = weightsCache.get(spec);
  if (cached) return cached;
  const built: Weights = {
    values: pieceValues(spec),
    race: racesHome(spec),
    territory: claimsGround(spec),
  };
  weightsCache.set(spec, built);
  return built;
};

/**
 * The position, from Red's point of view, in centipawn-ish units.
 *
 * Four terms, all of them derived from the spec rather than chosen for a game:
 * material by the capture graph, ground held when the mode has any, how far the
 * armies have advanced when the mode is a race, and a small mobility nudge so a
 * search with nothing else to go on prefers keeping its options open.
 */
const evaluate = (spec: RuleSpec, grid: Grid, weights: Weights): number => {
  const height = boardHeight(grid);
  const lastRank = height - 1;
  let score = 0;

  for (const row of grid) {
    for (const tile of row) {
      if (tile.occupant !== 'Empty' && tile.occupantOwner !== 'Neutral') {
        const value = weights.values[tile.occupant] ?? 100;
        score += tile.occupantOwner === 'Red' ? value : -value;
        if (weights.race) {
          // Red wins by reaching rank 1, Blue by reaching the last, so
          // advancement is distance travelled from your own home.
          const advance = tile.occupantOwner === 'Red' ? lastRank - tile.y : tile.y;
          score += (tile.occupantOwner === 'Red' ? 1 : -1) * advance * 6;
        }
      }
      if (weights.territory) {
        if (tile.ownerColor === 'Red') score += 12;
        else if (tile.ownerColor === 'Blue') score -= 12;
      }
    }
  }
  void spec;
  void boardWidth;
  return score;
};

/* ----------------------------------------------------------------- search -- */

interface SearchState {
  spec: RuleSpec;
  weights: Weights;
  nodes: number;
  deadline: number;
  maxNodes: number;
  stopped: StopReason | null;
}

/** Captures first: the cheapest ordering there is, and worth a lot to alpha-beta. */
const orderMoves = (game: AnalysisGame, moves: SpecMove[]): SpecMove[] =>
  [...moves].sort((first, second) => {
    const took = (move: SpecMove) => {
      const target = game.grid[move.to.y]?.[move.to.x];
      return move.jumped || (target && target.occupant !== 'Empty') ? 1 : 0;
    };
    return took(second) - took(first);
  });

/**
 * Negamax with alpha-beta, from the side to move's point of view.
 *
 * A finished game scores by *who* won and how soon: `WIN_SCORE - ply` so a win
 * in two beats a win in six, and a draw is zero however it was reached. Without
 * the ply term a search that has seen a win stops trying to reach it.
 */
const negamax = (
  state: SearchState,
  game: AnalysisGame,
  depth: number,
  ply: number,
  alphaIn: number,
  beta: number,
): number => {
  if (game.status !== 'InProgress') {
    if (game.winner === 'Neutral') return 0;
    const moverWon = game.winner === game.currentTurn;
    // A decided game leaves the winner to move, so "the side to move here" is
    // the winner exactly when the game was won rather than lost.
    return moverWon ? WIN_SCORE - ply : -(WIN_SCORE - ply);
  }
  if (state.nodes >= state.maxNodes) {
    state.stopped ??= 'nodes';
  } else if (Date.now() >= state.deadline) {
    state.stopped ??= 'time';
  }
  if (state.stopped) {
    const sign = game.currentTurn === 'Red' ? 1 : -1;
    return sign * evaluate(state.spec, game.grid, state.weights);
  }
  if (depth <= 0) {
    state.nodes += 1;
    const sign = game.currentTurn === 'Red' ? 1 : -1;
    return sign * evaluate(state.spec, game.grid, state.weights);
  }

  const moves = specAllMoves(state.spec, game);
  if (moves.length === 0) return 0; // stalemate is a draw in every mode

  let alpha = alphaIn;
  let best = -Infinity;
  for (const move of orderMoves(game, moves)) {
    state.nodes += 1;
    const played = specApplyMove(state.spec, game, move.from, move.to);
    if (!played) continue;
    // A mode with `extraTurn` or `movesPerTurn` can leave the same side to move,
    // in which case the score is *not* negated: negamax's sign flip is about
    // whose turn it is, not about how deep we are.
    const sameSide = played.game.currentTurn === game.currentTurn;
    const child = negamax(state, played.game, depth - 1, ply + 1, sameSide ? alpha : -beta, sameSide ? beta : -alpha);
    const score = sameSide ? child : -child;
    if (score > best) best = score;
    if (best > alpha) alpha = best;
    if (alpha >= beta) break;
    if (state.stopped) break;
  }
  return best === -Infinity ? 0 : best;
};

/**
 * A search over one spec, shaped as the engine call every bot already makes.
 *
 * Returns an `AnalyzeFn`, so `createBot(profile, { analyze: createSpecAnalyze(spec) })`
 * gives a custom mode the whole ladder — depth, blunder rate, tempo, draw
 * manners — with nothing else changed.
 */
export const createSpecAnalyze = (
  spec: RuleSpec,
  searchOptions: SpecSearchOptions = {},
): AnalyzeFn => {
  const weights = weightsFor(spec);
  const mode = modeDefinitionFor(spec, 'spec-search');

  return async (position, options = {}) => {
    const ceiling = { ...DEFAULTS, ...searchOptions };
    const maxDepth = Math.max(1, Math.min(options.maxDepth ?? ceiling.maxDepth, ceiling.maxDepth));
    const maxNodes = Math.min(options.maxNodes ?? ceiling.maxNodes, ceiling.maxNodes);
    const maxTimeMs = Math.min(options.maxTimeMs ?? ceiling.maxTimeMs, ceiling.maxTimeMs);
    const variations = Math.max(1, options.variations ?? 1);

    const startedAt = Date.now();
    const root = createAnalysisGameFrom(mode, position.grid, position.currentTurn);
    root.moveNumber = position.moveNumber;

    const state: SearchState = {
      spec,
      weights,
      nodes: 0,
      deadline: startedAt + maxTimeMs,
      maxNodes,
      stopped: null,
    };

    const moves = specAllMoves(spec, root);
    if (moves.length === 0) {
      return finished(state, startedAt, [], 0, 0, 'no-legal-move', root.currentTurn);
    }

    let lines: EngineLine[] = [];
    let reachedDepth = 0;
    let bestScore = 0;

    // Iterative deepening, so a search cut short by the clock still has a
    // complete answer from the depth before.
    for (let depth = 1; depth <= maxDepth; depth += 1) {
      const scored: { move: Move; score: number }[] = [];
      for (const move of orderMoves(root, moves)) {
        const played = specApplyMove(spec, root, move.from, move.to);
        if (!played) continue;
        state.nodes += 1;
        const sameSide = played.game.currentTurn === root.currentTurn;
        const child = negamax(state, played.game, depth - 1, 1, -Infinity, Infinity);
        scored.push({ move: { from: move.from, to: move.to }, score: sameSide ? child : -child });
        if (state.stopped) break;
      }
      if (scored.length === 0) break;
      scored.sort((first, second) => second.score - first.score);
      lines = scored.slice(0, variations).map((entry, index) => ({
        ...entry.move,
        score: entry.score,
        principalVariation: [entry.move],
        rank: index + 1,
      }));
      bestScore = scored[0]?.score ?? 0;
      reachedDepth = depth;
      if (state.stopped) break;
      if (Math.abs(bestScore) >= WIN_SCORE - 100) {
        state.stopped = 'terminal';
        break;
      }
    }

    return finished(
      state,
      startedAt,
      lines,
      reachedDepth,
      bestScore,
      state.stopped ?? 'depth',
      root.currentTurn,
    );
  };
};

const finished = (
  state: SearchState,
  startedAt: number,
  lines: EngineLine[],
  depth: number,
  score: number,
  stopReason: StopReason,
  turn: SideColor | 'Neutral',
): Analysis => {
  const elapsedMs = Math.max(1, Date.now() - startedAt);
  return {
    // Deliberately modest. This search has no book, no table and no tuning, so
    // claiming high confidence would be claiming something about a mode nobody
    // has ever played.
    confidence: Math.min(60, 20 + depth * 5),
    depth,
    elapsedMs,
    lines,
    nodes: state.nodes,
    nodesPerSecond: Math.round((state.nodes / elapsedMs) * 1000),
    redScore: turn === 'Blue' ? -score : score,
    score,
    selectiveDepth: depth,
    stopReason,
  };
};
