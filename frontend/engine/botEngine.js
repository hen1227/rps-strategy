import { allValidMoves, enginePosition } from './analysisGame';
import {
  BOT_TUNING,
  botProfile,
  choiceScoresFor,
  mannersScoresFor,
} from './botProfiles';
import { analyzeExclusive } from './rpsfishClient';

// A bot is a plain object that turns a position into a move. It holds no React
// state, touches no store, and never renders — the bot board drives one of
// these, and `botArena.js` drives two against each other. Everything that
// varies between difficulties comes from a profile in `botProfiles.js`.
//
// `analyze`, `random`, and `now` are injectable so a caller can drive a bot
// with a stub engine or a seeded generator, which is what makes bot-vs-bot
// runs reproducible.
//
// A profile states its choice and manners knobs as multiples of a per-mode
// unit, never as raw scores, because the two are not interchangeable: the same
// number of centipawns is a wide net in Annihilation and a hair's breadth in
// Infiltration. `choiceScoresFor` and `mannersScoresFor` resolve them against
// the mode actually being played, so the resolution happens once per decision
// rather than being baked into the profile.

/**
 * A deterministic splitmix64 stream returning floats in [0, 1).
 *
 * The same generator `RPSFish/src/selfplay.rs` uses, so a sequence of draws is
 * described by its seed in either language. Bot games run off one of these
 * rather than `Math.random` so a game can be replayed, and the arena runs off
 * one so a measurement can be.
 */
export const createSeededRandom = (seed) => {
  let state = BigInt.asUintN(64, BigInt(seed));
  const GAMMA = 0x9e3779b97f4a7c15n;
  const MIX_A = 0xbf58476d1ce4e5b9n;
  const MIX_B = 0x94d049bb133111ebn;
  const MASK = (1n << 64n) - 1n;
  return () => {
    state = (state + GAMMA) & MASK;
    let value = state;
    value = ((value ^ (value >> 30n)) * MIX_A) & MASK;
    value = ((value ^ (value >> 27n)) * MIX_B) & MASK;
    value ^= value >> 31n;
    // 53 bits is exactly what a double can hold without rounding.
    return Number(value >> 11n) / 2 ** 53;
  };
};

const MATE_SCORE_FLOOR = 29_000;

const wait = (milliseconds) =>
  milliseconds > 0
    ? new Promise((resolve) => setTimeout(resolve, milliseconds))
    : Promise.resolve();

const abortError = () => {
  const error = new Error('The bot stopped thinking.');
  error.name = 'AbortError';
  return error;
};

// Softmax over centipawn scores, relative to the best candidate. A larger
// temperature flattens the distribution, so the bot plays known-worse moves
// more often; zero collapses it onto the best move.
const sampleCandidate = (candidates, temperatureCp, random) => {
  if (candidates.length === 1 || !(temperatureCp > 0)) return candidates[0];
  const bestScore = candidates[0].score;
  const weights = candidates.map((candidate) =>
    Math.exp((candidate.score - bestScore) / temperatureCp),
  );
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  if (!(total > 0)) return candidates[0];

  let ticket = random() * total;
  for (let index = 0; index < candidates.length; index += 1) {
    ticket -= weights[index];
    if (ticket <= 0) return candidates[index];
  }
  return candidates[candidates.length - 1];
};

const candidateLineCount = (choice) =>
  Math.max(1, Math.min(choice.candidateLines, BOT_TUNING.maxCandidateLines));

// `line.score` is already from the point of view of the side to move, so a
// higher score is always better for the bot that is choosing.
const rankedCandidates = (analysis, choice) => {
  const lines = (analysis?.lines ?? [])
    .slice(0, candidateLineCount(choice))
    .map((line, index) => ({
      from: line.from,
      to: line.to,
      score: line.score,
      rank: index + 1,
    }));
  if (lines.length === 0) return [];

  const bestScore = lines[0].score;
  const withinGuardrail = lines.filter(
    (line) => bestScore - line.score <= choice.maxLossCp,
  );
  return withinGuardrail.length > 0 ? withinGuardrail : [lines[0]];
};

const randomLegalMove = (game, random) => {
  const moves = allValidMoves(game);
  if (moves.length === 0) return null;
  return moves[Math.min(moves.length - 1, Math.floor(random() * moves.length))];
};

export const createBot = (profileOrId, options = {}) => {
  const profile =
    typeof profileOrId === 'string' || profileOrId === undefined
      ? botProfile(profileOrId)
      : profileOrId;
  const {
    analyze = analyzeExclusive,
    analyzeRandomMoves = false,
    now = () => Date.now(),
    random = Math.random,
    sleep = wait,
  } = options;

  const search = (game, history, searchLimits, signal) =>
    analyze(
      {
        ...enginePosition(game),
        history: history.map(enginePosition),
      },
      {
        // The node ceiling is one shared safety valve rather than a per-profile
        // dial, so a profile's depth and timeout are what decide its strength.
        maxNodes: BOT_TUNING.maxNodes,
        ...searchLimits,
        throttleMs: BOT_TUNING.throttleMs,
        signal,
        variations: candidateLineCount(profile.choice),
      },
    );

  /**
   * Decide a move for the side to move.
   *
   * Resolves to `null` when the game is already over or the position has no
   * legal move; otherwise `{ from, to, rank, reason, score, analysis }`. The
   * promise waits out the profile's tempo before resolving, so callers can
   * apply the move the moment they receive it.
   */
  const chooseMove = async (game, { history = [], signal } = {}) => {
    if (game.status !== 'InProgress') return null;
    if (allValidMoves(game).length === 0) return null;

    const startedAt = now();
    const { tempo } = profile;
    const modeId = game.mode?.id;
    const choice = choiceScoresFor(profile.choice, modeId);
    const manners = mannersScoresFor(profile.manners, modeId);

    // The random roll normally skips the search entirely, which is both the
    // cheapest way to be weak and the most human-looking one. A watched arena
    // can opt into analysis for those moves without changing the choice.
    const rolledRandom = random() < choice.randomMoveChance;
    let analysis = null;
    let chosen = null;
    let reason = 'random';

    if (!rolledRandom || analyzeRandomMoves) {
      try {
        analysis = await search(game, history, profile.search, signal);
      } catch (error) {
        if (error?.name === 'AbortError') throw error;
        // A search failure must not freeze the board: the bot falls back to a
        // legal move and the game continues.
        analysis = null;
      }
    }

    if (rolledRandom) {
      // A watched bot battle still asks RPSFish to evaluate the position so
      // its chart and move grade remain complete, but the weak bot keeps the
      // random choice its profile called for.
      chosen = randomLegalMove(game, random);
    } else {
      const candidates = rankedCandidates(analysis, choice);
      if (candidates.length === 0) {
        chosen = randomLegalMove(game, random);
        reason = 'fallback';
      } else {
        chosen = sampleCandidate(candidates, choice.temperatureCp, random);
        reason = chosen.rank === 1 ? 'best' : 'sampled';
      }
    }
    if (!chosen) return null;
    if (signal?.aborted) throw abortError();

    const thinkMs =
      tempo.minThinkMs +
      random() * Math.max(0, tempo.maxThinkMs - tempo.minThinkMs);
    await sleep(Math.max(0, thinkMs - (now() - startedAt)));
    if (signal?.aborted) throw abortError();

    return {
      analysis,
      from: chosen.from,
      rank: chosen.rank ?? null,
      reason,
      score: chosen.score ?? null,
      to: chosen.to,
      elapsedMs: now() - startedAt,
      // A resignable position is reported rather than acted on, so the caller
      // decides when a bot game actually ends.
      resigns:
        manners.resignBelowCp !== null &&
        game.moveNumber >= manners.resignAfterMove &&
        typeof chosen.score === 'number' &&
        Math.abs(chosen.score) < MATE_SCORE_FLOOR &&
        chosen.score <= manners.resignBelowCp,
    };
  };

  /**
   * Answer a draw offer. `scoreForBotCp` is the evaluation from this bot's own
   * point of view, so a positive number means the bot is winning and should
   * play on. A bot that cannot see the position clearly enough to judge it — no
   * evaluation, or the offer arrives before its patience runs out — declines,
   * which is what a person does when they still want to play.
   */
  const acceptsDraw = (game, scoreForBotCp) => {
    const manners = mannersScoresFor(profile.manners, game.mode?.id);
    if (game.moveNumber < manners.acceptDrawAfterMove) return false;
    if (typeof scoreForBotCp !== 'number' || Number.isNaN(scoreForBotCp)) return false;
    // A mate score is never within a draw's reach: the bot takes the draw only
    // when it is the one being mated.
    if (Math.abs(scoreForBotCp) >= MATE_SCORE_FLOOR) return scoreForBotCp < 0;
    return scoreForBotCp <= manners.acceptDrawWithinCp;
  };

  return {
    acceptsDraw,
    blurb: profile.blurb,
    chooseMove,
    id: profile.id,
    name: profile.name,
    profile,
    rating: profile.rating,
    // Exposed so a caller can ask this bot for an evaluation with limits of
    // its own — the hint button uses it with `BOT_TUNING.hint`.
    search: (game, { history = [], signal, limits = profile.search } = {}) =>
      search(game, history, limits, signal),
  };
};
