import {
  allValidMoves,
  applyAnalysisMove,
  createAnalysisGame,
} from './analysisGame';
import { createSeededRandom } from './botEngine';
import { BOT_TUNING } from './botProfiles';

// Two bots, one board, no UI. This is the seam that makes bot-vs-bot testing
// possible: the bot board in the app drives a single bot through the same
// `chooseMove` contract, so anything that plays here plays there.
//
// The measurement rules here are the same ones `RPSFish/src/bin/arena.rs`
// follows, because a ladder measured loosely is a ladder tuned to noise:
//
//   1. Seeded randomness. A run is reproducible from its seed alone, so a
//      surprising result can be replayed rather than argued about.
//   2. Paired, colour-swapped openings. Each opening is played twice with the
//      colours reversed and the same bot seeds, which cancels both opening
//      bias and first-move advantage. It does not cancel the bots' own
//      randomness, so only a pair of deterministic profiles — the top rung,
//      which samples nothing — scores exactly 0.5000 against itself. That is
//      this file's sanity check; a noisy profile only lands near 0.5.
//   3. Elo with a confidence interval. A raw win count cannot tell "clearly
//      stronger" from "30 games of luck"; +80 Elo over 30 games is not a
//      measurement, and the interval is what says so.
//
// Note that games here are adjudicated by `analysisGame.js`, the JavaScript
// rules, while the moves come from RPSFish. That is the same pairing the app
// ships, so it is the right thing to measure, but it is not a rules check.

// Re-exported so a measurement run needs only this module: the arena's seed
// and the bots' seeds come from the same generator.
export { createSeededRandom };

const otherColor = (color) => (color === 'Red' ? 'Blue' : 'Red');

/**
 * Walk `plies` random legal moves from the mode's starting position.
 *
 * Returns `null` if the walk decided or stalemated the game, which would make
 * the opening unplayable; callers retry with the next seed. Mirrors
 * `selfplay::random_opening`.
 */
export const randomOpening = (mode, plies, random) => {
  let game = createAnalysisGame(mode);
  const history = [];
  for (let ply = 0; ply < plies; ply += 1) {
    if (game.status !== 'InProgress') return null;
    const moves = allValidMoves(game);
    if (moves.length === 0) return null;
    const choice = moves[Math.min(moves.length - 1, Math.floor(random() * moves.length))];
    const result = applyAnalysisMove(game, choice.from, choice.to);
    if (!result) return null;
    history.push(game);
    game = result.game;
  }
  return game.status === 'InProgress' ? { game, history } : null;
};

/**
 * Play one game between two bots and return the result.
 *
 * `onMove({ game, move, moveNumber })` is called after every applied move so a
 * caller can render, log, or stream the game. Pass an AbortSignal to stop
 * between moves. `startGame`/`startHistory` begin from a position other than
 * the mode's opening, which is how paired openings are played.
 *
 * `adjudicateResignations` ends a game when the losing bot's own
 * `manners.resignBelow*` threshold is crossed. It is off by default and should
 * stay off for anything whose number gets recorded: the app never lets a bot
 * resign against a person, so a measurement that does is measuring a bot that
 * does not ship. Turn it on only to shorten an exploratory run, and expect the
 * result to differ — decided positions still have to be converted, and a bot
 * that cannot convert one should lose the Elo for it.
 */
export const playBotGame = async ({
  adjudicateResignations = false,
  blueBot,
  maxMoves = BOT_TUNING.maxMovesPerArenaGame,
  mode,
  onAnalysis,
  onMove,
  redBot,
  signal,
  startGame,
  startHistory,
}) => {
  let game = startGame ?? createAnalysisGame(mode);
  const history = [...(startHistory ?? [])];
  const moves = [];

  while (game.status === 'InProgress' && moves.length < maxMoves) {
    if (signal?.aborted) break;
    const mover = game.currentTurn;
    const bot = mover === 'Red' ? redBot : blueBot;
    const decision = await bot.chooseMove(game, { history, signal });
    if (!decision) break;

    onAnalysis?.({
      analysis: decision.analysis,
      decision,
      game,
      moveNumber: moves.length,
    });

    if (adjudicateResignations && decision.resigns) {
      game = {
        ...game,
        status: 'Finished',
        winner: otherColor(mover),
        endReason: 'resignation',
      };
      break;
    }

    const result = applyAnalysisMove(game, decision.from, decision.to);
    // A bot that proposes an illegal move is a bug in that bot, not a reason
    // to hang the arena, so the game is abandoned instead of looping.
    if (!result) break;

    history.push(game);
    game = result.game;
    moves.push({
      analysis: decision.analysis,
      elapsedMs: decision.elapsedMs,
      from: decision.from,
      mover,
      rank: decision.rank,
      reason: decision.reason,
      score: decision.score,
      to: decision.to,
    });
    onMove?.({ game, move: moves[moves.length - 1], moveNumber: moves.length });
  }

  const hitMoveLimit = game.status === 'InProgress' && moves.length >= maxMoves;
  return {
    endReason: hitMoveLimit ? 'move_limit' : game.endReason,
    finalGame: game,
    moves,
    winner: hitMoveLimit ? 'Neutral' : game.winner,
  };
};

/**
 * Play one opening twice with the colours swapped.
 *
 * Both games use the same opening and the same pair of bot seeds, so the only
 * difference between them is which bot moved first. Returns the two results
 * and `firstBotPoints` out of 2.
 */
export const playBotPair = async ({
  adjudicateResignations,
  buildBots,
  mode,
  onGame,
  openingPlies,
  seed,
  signal,
}) => {
  const openingRandom = createSeededRandom(seed);
  let opening = null;
  // A walk that decides the game is unplayable; try a few neighbouring seeds
  // before giving up on this pair rather than skewing the sample.
  for (let attempt = 0; attempt < 16 && !opening; attempt += 1) {
    opening = randomOpening(mode, openingPlies, openingRandom);
  }
  if (!opening) return null;

  const results = [];
  let firstBotPoints = 0;
  for (const firstIsRed of [true, false]) {
    if (signal?.aborted) break;
    // Rebuilt per game so each bot starts from the same seeded stream: a bot
    // that consumed extra randomness in game one must not shift game two.
    const { firstBot, secondBot } = buildBots(seed);
    const result = await playBotGame({
      adjudicateResignations,
      blueBot: firstIsRed ? secondBot : firstBot,
      mode,
      redBot: firstIsRed ? firstBot : secondBot,
      signal,
      startGame: opening.game,
      startHistory: opening.history,
    });
    const firstBotColor = firstIsRed ? 'Red' : 'Blue';
    if (result.winner === 'Neutral') firstBotPoints += 1;
    else if (result.winner === firstBotColor) firstBotPoints += 2;
    results.push({ ...result, firstBotColor });
    onGame?.({ ...result, firstBotColor, seed });
  }

  // Points are doubled so a draw stays an integer.
  return { firstBotPoints, results, seed };
};

/**
 * Play `pairs` paired openings and report the result with a confidence
 * interval, from the first bot's point of view.
 */
export const playBotMatch = async ({
  adjudicateResignations,
  buildBots,
  mode,
  onGame,
  onPair,
  openingPlies = BOT_TUNING.arenaOpeningPlies,
  pairs = 25,
  seed = 1,
  signal,
}) => {
  const tally = {
    draws: 0,
    endReasons: {},
    firstBotWins: 0,
    games: [],
    secondBotWins: 0,
  };
  for (let index = 0; index < pairs; index += 1) {
    if (signal?.aborted) break;
    const pair = await playBotPair({
      adjudicateResignations,
      buildBots,
      mode,
      onGame,
      openingPlies,
      // Distinct, reproducible, and not adjacent: neighbouring splitmix64
      // seeds produce unrelated streams, but spacing them keeps the openings
      // obviously independent when a run is being debugged.
      seed: seed * 1_000_003 + index,
      signal,
    });
    if (!pair) continue;
    for (const result of pair.results) {
      if (result.winner === 'Neutral') tally.draws += 1;
      else if (result.winner === result.firstBotColor) tally.firstBotWins += 1;
      else tally.secondBotWins += 1;
      // How games end is how the manners knobs get checked. A threshold that
      // never appears here is a threshold that is never reached.
      const reason = result.endReason ?? 'unknown';
      tally.endReasons[reason] = (tally.endReasons[reason] ?? 0) + 1;
      tally.games.push(result);
    }
    onPair?.({ ...pair, index });
  }
  return { ...tally, statistics: matchStatistics(tally) };
};

// +-800 is the reporting ceiling. Beyond it the logistic curve is so flat that
// the number says "no losses yet" rather than anything about strength.
const ELO_LIMIT = 800;

const scoreToElo = (score) => {
  if (score <= 0) return -ELO_LIMIT;
  if (score >= 1) return ELO_LIMIT;
  const elo = -400 * Math.log10(1 / score - 1);
  return Math.min(ELO_LIMIT, Math.max(-ELO_LIMIT, elo));
};

/**
 * Elo and a 95% interval.
 *
 * The point estimate is the raw score, the same one `arena.rs` reports. The
 * interval is not taken from the raw score, because a clean sweep has zero
 * observed variance and the normal approximation then returns an interval that
 * is both inverted and absurdly narrow — 10-0 would read as "[+2483, +800]".
 * One drawn game is added to each side first, which is symmetric, costs
 * nothing at large sample sizes, and turns that same sweep into an honest
 * "somewhere above +250, and this many games cannot say where".
 */
export const matchStatistics = (tally) => {
  const games = tally.firstBotWins + tally.secondBotWins + tally.draws;
  if (games === 0) {
    return { elo: 0, eloHigh: 0, eloLow: 0, games: 0, score: 0.5 };
  }
  const score = (tally.firstBotWins + 0.5 * tally.draws) / games;

  const paddedGames = games + 2;
  const paddedWins = tally.firstBotWins / paddedGames;
  const paddedDraws = (tally.draws + 2) / paddedGames;
  const paddedScore = paddedWins + 0.5 * paddedDraws;
  // Variance of a single game's score, where a game scores 0, 0.5 or 1.
  const variance =
    Math.max(paddedWins + 0.25 * paddedDraws - paddedScore * paddedScore, 1e-12) /
    paddedGames;
  const deviation = Math.sqrt(variance);
  const clamp = (value) => Math.min(1, Math.max(0, value));
  const elo = scoreToElo(score);
  return {
    elo,
    eloHigh: Math.max(elo, scoreToElo(clamp(paddedScore + 1.96 * deviation))),
    eloLow: Math.min(elo, scoreToElo(clamp(paddedScore - 1.96 * deviation))),
    games,
    score,
  };
};

/**
 * Play a series and tally it from the first bot's point of view. Colours
 * alternate every game so neither bot keeps the first move.
 *
 * Retained for callers that only want a quick tally from the starting
 * position. `playBotMatch` is the one to use for a number worth acting on.
 */
export const playBotSeries = async ({
  firstBot,
  games = 2,
  mode,
  onGame,
  secondBot,
  signal,
}) => {
  const tally = { draws: 0, firstBotWins: 0, games: [], secondBotWins: 0 };

  for (let index = 0; index < games; index += 1) {
    if (signal?.aborted) break;
    const firstIsRed = index % 2 === 0;
    const result = await playBotGame({
      blueBot: firstIsRed ? secondBot : firstBot,
      mode,
      redBot: firstIsRed ? firstBot : secondBot,
      signal,
    });
    const firstBotColor = firstIsRed ? 'Red' : 'Blue';
    if (result.winner === 'Neutral') tally.draws += 1;
    else if (result.winner === firstBotColor) tally.firstBotWins += 1;
    else tally.secondBotWins += 1;
    tally.games.push({ ...result, firstBotColor });
    onGame?.({ ...result, firstBotColor, index });
  }

  return { ...tally, statistics: matchStatistics(tally) };
};
