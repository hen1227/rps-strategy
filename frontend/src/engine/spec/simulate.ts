// Play a mode against itself, and say what happened.
//
// This is what turns the Lab's agent from a code generator into a playtester. A
// spec that validates is a spec that *runs*; whether it is a game is a different
// question, and the only way to answer it is to play it.
//
// Three things it reports, in rising order of usefulness:
//
//  1. **Who wins.** A mode where Red wins nine times in ten is broken in a way no
//     amount of reading the rules would show.
//  2. **How it ends.** A mode that only ever reaches the move limit has a win
//     condition nobody can satisfy.
//  3. **Which rules never fired.** The one an author cannot get any other way:
//     the jump they added that no position ever allows, the win condition that
//     is unreachable, the piece that never moves. Silence about a rule is the
//     most common kind of wrong, and the hardest to see by reading.
//
// Deliberately seeded. A balance number that changes when you look at it again
// is not a number anybody can act on.

import { createAnalysisGame, type AnalysisGame } from '../analysisGame';
import { createSeededRandom, type RandomSource } from '../bots/engine';
import { modeDefinitionFor, specAllMoves, specApplyMove, type SpecMove } from './interpret';
import type { RuleSpec } from './types';
import type { PlayerColor } from '@/types/game';

export interface SimulateOptions {
  /** How many games. More is steadier and slower; 40 is a useful default. */
  games?: number;
  /** Plies before a game is abandoned as unfinished. */
  plyLimit?: number;
  seed?: number;
  /**
   * How well the two sides play, from 0 (uniformly random) to 1 (always the
   * search's choice). Random play answers "can this game be finished at all";
   * strong play answers "is it a good game". Both are worth asking, and they
   * often disagree.
   */
  strength?: number;
  /** Search depth when `strength` is above zero. */
  depth?: number;
  /** Stop early. The Lab passes the tool call's signal. */
  signal?: AbortSignal;
}

export interface SimulateReport {
  games: number;
  redWins: number;
  blueWins: number;
  draws: number;
  /** Games that hit the ply limit with nobody winning. */
  unfinished: number;
  averagePlies: number;
  longestGame: number;
  shortestGame: number;
  /** How games ended, by `endReason`, commonest first. */
  endings: { reason: string; games: number }[];
  /** Win conditions that fired at least once, by their `id` or index. */
  winConditionsFired: string[];
  /** Win conditions that never fired in any game. */
  winConditionsNeverFired: string[];
  /** Movement rules that produced at least one legal move. */
  movementRulesUsed: string[];
  movementRulesNeverUsed: string[];
  /** Piece kinds that never legally moved. */
  piecesThatNeverMoved: string[];
  /** Plain-language notes an author can act on. */
  notes: string[];
  elapsedMs: number;
}

/** How a rule is named in the report: its own id, or its position. */
const winConditionName = (spec: RuleSpec, index: number) =>
  spec.win[index]?.id ?? `win[${index}]`;

const movementRuleName = (spec: RuleSpec, index: number) => {
  const rule = spec.movement[index];
  if (!rule) return `movement[${index}]`;
  const pieces = rule.piece === undefined ? 'any' : [rule.piece].flat().join('/');
  return `movement[${index}] ${rule.kind} (${pieces})`;
};

/**
 * Which movement rule produced a move.
 *
 * Re-derived rather than carried on the move, because knowing it matters only
 * here — a search asks for legal moves millions of times and should not pay to
 * label them. A move is credited to the first rule that could have made it,
 * which is the same tie-break `dedupe` uses.
 */
const creditRule = (spec: RuleSpec, game: AnalysisGame, move: SpecMove): number => {
  const piece = game.grid[move.from.y]?.[move.from.x]?.occupant;
  for (let index = 0; index < spec.movement.length; index += 1) {
    const rule = spec.movement[index];
    if (!rule || piece === undefined) continue;
    if (rule.piece !== undefined && ![rule.piece].flat().includes(piece)) continue;
    if (rule.kind === 'jumpOver' && !move.jumped) continue;
    if (rule.kind !== 'jumpOver' && move.jumped) continue;
    return index;
  }
  return -1;
};

const pickMove = (
  moves: SpecMove[],
  random: RandomSource,
  strength: number,
  scored: (() => SpecMove | null) | null,
): SpecMove | null => {
  if (moves.length === 0) return null;
  if (strength > 0 && scored && random() < strength) {
    const best = scored();
    if (best) return best;
  }
  return moves[Math.floor(random() * moves.length)] ?? null;
};

export const simulate = (spec: RuleSpec, options: SimulateOptions = {}): SimulateReport => {
  const {
    games = 40,
    plyLimit = 200,
    seed = 1,
    strength = 0,
    depth = 2,
    signal,
  } = options;
  const startedAt = Date.now();
  const mode = modeDefinitionFor(spec, 'simulation');

  let redWins = 0;
  let blueWins = 0;
  let draws = 0;
  let unfinished = 0;
  let totalPlies = 0;
  let longest = 0;
  let shortest = Number.POSITIVE_INFINITY;
  const endings = new Map<string, number>();
  const winFired = new Set<string>();
  const rulesUsed = new Set<number>();
  const piecesMoved = new Set<string>();

  for (let index = 0; index < games; index += 1) {
    if (signal?.aborted) break;
    const random = createSeededRandom(seed * 1_000_003 + index);
    let game = createAnalysisGame(mode);
    let plies = 0;

    while (game.status === 'InProgress' && plies < plyLimit) {
      const moves = specAllMoves(spec, game);
      if (moves.length === 0) break;
      // A shallow greedy pick rather than the full search: a playtest runs
      // hundreds of games and wants an answer this minute. `strength` is the
      // share of moves played this way rather than at random.
      const current = game;
      const greedy = () => bestByShallowLook(spec, current, moves, depth);
      const move = pickMove(moves, random, strength, greedy);
      if (!move) break;
      rulesUsed.add(creditRule(spec, game, move));
      const piece = game.grid[move.from.y]?.[move.from.x]?.occupant;
      if (piece && piece !== 'Empty') piecesMoved.add(piece);
      const played = specApplyMove(spec, game, move.from, move.to);
      if (!played) break;
      game = played.game;
      plies += 1;
    }

    totalPlies += plies;
    longest = Math.max(longest, plies);
    shortest = Math.min(shortest, plies);

    if (game.status !== 'InProgress') {
      const reason = game.endReason ?? 'unknown';
      endings.set(reason, (endings.get(reason) ?? 0) + 1);
      recordWinner(game.winner);
      // A mode's own win conditions carry their reason, so an ending names the
      // rule that produced it without the interpreter having to report one.
      spec.win.forEach((condition, position) => {
        if ((condition.reason ?? 'game_rule') === reason) {
          winFired.add(winConditionName(spec, position));
        }
      });
    } else {
      unfinished += 1;
      endings.set('unfinished', (endings.get('unfinished') ?? 0) + 1);
    }
  }

  function recordWinner(winner: PlayerColor) {
    if (winner === 'Red') redWins += 1;
    else if (winner === 'Blue') blueWins += 1;
    else draws += 1;
  }

  const played = redWins + blueWins + draws + unfinished || 1;
  const neverFiredWins = spec.win
    .map((_unused, position) => winConditionName(spec, position))
    .filter((name) => !winFired.has(name));
  const usedRuleNames = [...rulesUsed]
    .filter((index) => index >= 0)
    .map((index) => movementRuleName(spec, index));
  const neverUsedRules = spec.movement
    .map((_unused, index) => movementRuleName(spec, index))
    .filter((name) => !usedRuleNames.includes(name));
  const stillPieces = spec.pieces
    .map((piece) => piece.id)
    .filter((kind) => !piecesMoved.has(kind));

  return {
    games: played,
    redWins,
    blueWins,
    draws,
    unfinished,
    averagePlies: Math.round(totalPlies / played),
    longestGame: longest,
    shortestGame: shortest === Number.POSITIVE_INFINITY ? 0 : shortest,
    endings: [...endings.entries()]
      .map(([reason, count]) => ({ reason, games: count }))
      .sort((first, second) => second.games - first.games),
    winConditionsFired: [...winFired].sort(),
    winConditionsNeverFired: neverFiredWins,
    movementRulesUsed: usedRuleNames.sort(),
    movementRulesNeverUsed: neverUsedRules,
    piecesThatNeverMoved: stillPieces,
    notes: notesFor({
      games: played,
      redWins,
      blueWins,
      draws,
      unfinished,
      neverFiredWins,
      neverUsedRules,
      stillPieces,
    }),
    elapsedMs: Date.now() - startedAt,
  };
};

/**
 * One ply of look-ahead, greedily.
 *
 * Not the real search: a playtest is hundreds of games and the point is the
 * shape of the outcomes, not the quality of the play. `strength` is how often a
 * side bothers, so an author can ask both "can this be finished by anybody" and
 * "does it hold up when both sides try".
 */
const bestByShallowLook = (
  spec: RuleSpec,
  game: AnalysisGame,
  moves: SpecMove[],
  depth: number,
): SpecMove | null => {
  let best: SpecMove | null = null;
  let bestScore = -Infinity;
  for (const move of moves) {
    const played = specApplyMove(spec, game, move.from, move.to);
    if (!played) continue;
    let score = 0;
    if (played.game.status !== 'InProgress') {
      score = played.game.winner === game.currentTurn ? 1_000 : played.game.winner === 'Neutral' ? 0 : -1_000;
    } else {
      score = played.captured ? 10 : 0;
      if (depth > 1) {
        // One more ply: how much the opponent can take straight back.
        const replies = specAllMoves(spec, played.game);
        const captures = replies.filter((reply) => {
          const target = played.game.grid[reply.to.y]?.[reply.to.x];
          return reply.jumped || (target && target.occupant !== 'Empty');
        }).length;
        score -= captures * 3;
      }
    }
    if (score > bestScore) {
      bestScore = score;
      best = move;
    }
  }
  return best;
};

/** The report in words, because a table of counts is not advice. */
const notesFor = (summary: {
  games: number;
  redWins: number;
  blueWins: number;
  draws: number;
  unfinished: number;
  neverFiredWins: string[];
  neverUsedRules: string[];
  stillPieces: string[];
}): string[] => {
  const notes: string[] = [];
  const decisive = summary.redWins + summary.blueWins;
  if (decisive > 0) {
    const redShare = summary.redWins / decisive;
    if (redShare >= 0.75) {
      notes.push(
        `Red wins ${Math.round(redShare * 100)}% of decisive games. Moving first may be too strong here.`,
      );
    } else if (redShare <= 0.25) {
      notes.push(
        `Blue wins ${Math.round((1 - redShare) * 100)}% of decisive games, despite moving second.`,
      );
    }
  }
  if (summary.unfinished / summary.games >= 0.5) {
    notes.push(
      `${summary.unfinished} of ${summary.games} games never ended. A win condition may be unreachable, or the mode may need a moveLimit.`,
    );
  }
  if (decisive === 0 && summary.games > 0) {
    notes.push('Nobody ever won. Check that some win condition can actually be satisfied.');
  }
  for (const name of summary.neverFiredWins) {
    notes.push(`The win condition "${name}" never fired in any game.`);
  }
  for (const name of summary.neverUsedRules) {
    notes.push(`No legal move ever came from ${name}.`);
  }
  for (const kind of summary.stillPieces) {
    notes.push(`No ${kind} ever moved.`);
  }
  if (notes.length === 0) {
    notes.push('Nothing looks obviously broken: both sides win, games finish, and every rule fired.');
  }
  return notes;
};
