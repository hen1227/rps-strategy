// Measure what an RPSFish score is worth, in games.
//
// The review screen turns an evaluation into a win probability, and every
// number a player sees — move grades, accuracy — is downstream of that one
// conversion. Guessing its shape would make the whole report a guess, so it
// is fitted here instead: play games, record the evaluation at every position
// and the result the game actually reached, and find the logistic that
// predicts one from the other.
//
// usage:
//   node scripts/reviewCalibration.mjs --games 40 --depth 6
//   node scripts/reviewCalibration.mjs --mode V5 --games 80

import { register } from 'node:module';
import { performance } from 'node:perf_hooks';

import { startEngineWorker } from './engineWorker.mjs';

register('./arena-loader.mjs', import.meta.url);

const argument = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] && !process.argv[index + 1].startsWith('--')
    ? process.argv[index + 1]
    : fallback;
};

const LARGE = [
  '...SSS...', '...PPP...', '...RRR...',
  '.........', '.........', '.........',
  '...rrr...', '...ppp...', '...sss...',
];
const MODES = {
  V1: {
    id: 'V1',
    name: 'Annihilation',
    startingPosition: {
      rows: [
        '.........', '.........', '.........',
        '.R.....s.', '.P.....p.', '.S.....r.',
        '.........', '.........', '.........',
      ],
    },
  },
  V5: { id: 'V5', name: 'Total War', startingPosition: { rows: LARGE } },
  V3: { id: 'V3', name: 'Infiltration', startingPosition: { rows: LARGE } },
};

const seededRandom = (seed) => {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0x1_0000_0000;
  };
};

/**
 * Play one game, sampling among the engine's own top moves.
 *
 * Always playing the best move produces one game and no losing positions, so
 * the sample would contain nothing to calibrate against. Sampling is what
 * makes games end differently from where they started, which is the entire
 * signal here.
 */
const playGame = async ({ analyze, mode, plies, random, depth, createAnalysisGame, applyAnalysisMove, enginePosition }) => {
  let game = createAnalysisGame(mode);
  const past = [];
  const samples = [];
  for (let ply = 0; ply < plies && game.status === 'InProgress'; ply += 1) {
    const analysis = await analyze(
      { ...enginePosition(game), history: past.map(enginePosition) },
      { maxDepth: depth, maxNodes: 300_000, maxTimeMs: 1_500, throttleMs: 0, variations: 4 },
    );
    if (!analysis.lines.length) break;
    samples.push({ ply, redScore: analysis.redScore });
    // Mostly the best move, sometimes a worse one: a mix of good and bad play
    // is what puts positions across the whole evaluation range into the fit.
    const index = random() < 0.72 ? 0 : Math.floor(random() * analysis.lines.length);
    const choice = analysis.lines[Math.min(index, analysis.lines.length - 1)];
    past.push(game);
    game = applyAnalysisMove(game, choice.from, choice.to).game;
  }
  // A game that hit the ply cap is not evidence about who was going to win.
  // Calling it a draw would tell the fit that every evaluation in it was
  // worth half a point, which is the one thing it is certain not to be.
  const finished = game.status === 'Finished';
  const redPoints = !finished ? null : game.winner === 'Red' ? 1 : game.winner === 'Blue' ? 0 : 0.5;
  return { samples, redPoints, finished, plies: past.length, endReason: game.endReason };
};

// Log-likelihood of the one-parameter logistic p = 1 / (1 + exp(-k * score)),
// scored against expected points rather than a win flag so a draw is the
// half-point it is.
const logLikelihood = (samples, k) => {
  let total = 0;
  for (const { redScore, redPoints } of samples) {
    const p = 1 / (1 + Math.exp(-k * redScore));
    const clamped = Math.min(1 - 1e-12, Math.max(1e-12, p));
    total += redPoints * Math.log(clamped) + (1 - redPoints) * Math.log(1 - clamped);
  }
  return total;
};

// One parameter and a concave likelihood, so a golden-section search on a
// bracketing interval is both exact enough and obviously correct.
const fitLogistic = (samples) => {
  let low = 1e-5;
  let high = 0.2;
  const phi = (Math.sqrt(5) - 1) / 2;
  for (let iteration = 0; iteration < 200; iteration += 1) {
    const a = high - phi * (high - low);
    const b = low + phi * (high - low);
    if (logLikelihood(samples, a) < logLikelihood(samples, b)) low = a;
    else high = b;
  }
  return (low + high) / 2;
};

const calibrationTable = (samples, k) => {
  const edges = [-Infinity, -400, -200, -100, -50, -20, 20, 50, 100, 200, 400, Infinity];
  const rows = [];
  for (let index = 0; index + 1 < edges.length; index += 1) {
    const inBucket = samples.filter(
      (sample) => sample.redScore >= edges[index] && sample.redScore < edges[index + 1],
    );
    if (inBucket.length < 20) continue;
    const actual = inBucket.reduce((total, sample) => total + sample.redPoints, 0) / inBucket.length;
    const predicted =
      inBucket.reduce((total, sample) => total + 1 / (1 + Math.exp(-k * sample.redScore)), 0) /
      inBucket.length;
    rows.push({
      range: `${edges[index] === -Infinity ? '  -inf' : edges[index].toString().padStart(6)} .. ${
        edges[index + 1] === Infinity ? '+inf' : edges[index + 1]
      }`,
      n: inBucket.length,
      actual,
      predicted,
    });
  }
  return rows;
};

const main = async () => {
  const { analyze } = await startEngineWorker();
  const { applyAnalysisMove, createAnalysisGame, enginePosition } = await import(
    '../engine/analysisGame.js'
  );

  const games = Number(argument('games', 40));
  const depth = Number(argument('depth', 6));
  const plies = Number(argument('plies', 400));
  const seed = Number(argument('seed', 20260821));
  const modeIds = argument('mode', 'all') === 'all' ? ['V1', 'V5', 'V3'] : argument('mode').split(',');

  console.log(`${games} games per mode, depth ${depth}, up to ${plies} plies, seed ${seed}\n`);
  for (const modeId of modeIds) {
    const mode = MODES[modeId];
    const started = performance.now();
    const samples = [];
    const outcomes = { red: 0, blue: 0, draw: 0, unfinished: 0 };
    for (let index = 0; index < games; index += 1) {
      const result = await playGame({
        analyze,
        mode,
        plies,
        depth,
        random: seededRandom(seed + index * 7919),
        createAnalysisGame,
        applyAnalysisMove,
        enginePosition,
      });
      if (!result.finished) {
        outcomes.unfinished += 1;
        continue;
      }
      if (result.redPoints === 1) outcomes.red += 1;
      else if (result.redPoints === 0) outcomes.blue += 1;
      else outcomes.draw += 1;
      for (const sample of result.samples) {
        samples.push({ ...sample, redPoints: result.redPoints });
      }
    }

    const k = fitLogistic(samples);
    // The score at which the side to move expects three points in four, which
    // is a far more legible way to state k than k itself.
    const seventyFive = Math.log(3) / k;
    const elapsed = ((performance.now() - started) / 1000).toFixed(1);
    console.log(
      `${mode.name} (${modeId})  ${samples.length} positions from ${games} games in ${elapsed}s` +
        `  [red ${outcomes.red} / draw ${outcomes.draw} / blue ${outcomes.blue}` +
        `${outcomes.unfinished ? ` / ${outcomes.unfinished} unfinished, discarded` : ''}]`,
    );
    console.log(`  k = ${k.toFixed(6)}   75% expected score at ${seventyFive.toFixed(0)} centipawns`);
    console.log('  score range        n   actual  predicted');
    for (const row of calibrationTable(samples, k)) {
      console.log(
        `  ${row.range.padEnd(16)} ${String(row.n).padStart(5)}   ${row.actual.toFixed(3)}     ${row.predicted.toFixed(3)}`,
      );
    }
    console.log('');
  }
};

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
