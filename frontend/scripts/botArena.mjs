// Measure the bot ladder headlessly, against the engine build that ships.
//
// usage:
//   node scripts/botArena.mjs --ladder --pairs 25
//   node scripts/botArena.mjs --a crane --b boulder --mode V3 --pairs 40
//   node scripts/botArena.mjs --spread            (root-score gaps per mode)
//   node scripts/botArena.mjs --ladder --adjudicate   (faster, less faithful)
//
// Why this exists: the ladder used to be measured by hand in a browser tab, 30
// games per pair with no seed, no paired openings, and no confidence interval.
// Thirty games puts a 95% interval of roughly +-16 percentage points on a
// result, which is +-120 Elo — wide enough to "measure" a rung difference that
// is not there. This runs the same bots, the same worker, and the same WASM
// with seeded openings and reports an interval, so a tuning change can be
// believed or rejected.
//
// The worker is not reimplemented here. `frontend/public/rpsfish/` is loaded
// and executed as-is inside a vm context with the three browser globals it
// touches, so what this measures is the shipped path rather than a model of it.

import { readFile } from 'node:fs/promises';
import { createContext, runInContext } from 'node:vm';
import { register } from 'node:module';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { dirname, resolve as resolvePath } from 'node:path';

register('./arena-loader.mjs', import.meta.url);

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKER_PATH = resolvePath(HERE, '../public/rpsfish/rpsfish-worker.js');
const WASM_PATH = resolvePath(HERE, '../public/rpsfish/rpsfish.wasm');

const argument = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] && !process.argv[index + 1].startsWith('--')
    ? process.argv[index + 1]
    : fallback;
};
const flag = (name) => process.argv.includes(`--${name}`);

// Load the shipped worker into a vm context and expose it as an `analyze`
// function shaped like `rpsfishClient.analyzeExclusive`.
const startWorker = async () => {
  const [source, wasmBytes] = await Promise.all([
    readFile(WORKER_PATH, 'utf8'),
    readFile(WASM_PATH),
  ]);

  let onMessage;
  const listeners = new Map();
  const sandbox = {
    WebAssembly,
    performance,
    setTimeout,
    clearTimeout,
    console,
    URL,
    BigInt,
    Error,
    // The worker fetches `./rpsfish.wasm` relative to its own location; in this
    // context every fetch resolves to the one file it can possibly want.
    fetch: async () => ({
      ok: true,
      status: 200,
      clone() {
        return this;
      },
      arrayBuffer: async () => wasmBytes,
    }),
  };
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  Object.defineProperty(sandbox, 'onmessage', {
    get: () => onMessage,
    set: (handler) => {
      onMessage = handler;
    },
  });
  sandbox.location = { href: 'https://arena.invalid/rpsfish/rpsfish-worker.js', search: '' };
  sandbox.postMessage = (data) => {
    const listener = listeners.get(data?.requestId);
    if (listener) listener(data);
  };
  // `WebAssembly.instantiateStreaming` needs a real Response; skipping it sends
  // the worker down its own documented fallback path.
  sandbox.WebAssembly = { instantiate: WebAssembly.instantiate.bind(WebAssembly) };

  createContext(sandbox);
  runInContext(source, sandbox, { filename: WORKER_PATH });

  let nextRequestId = 1;
  return (position, options = {}) => {
    const requestId = nextRequestId++;
    const { signal, ...engineOptions } = options;
    return new Promise((resolvePromise, rejectPromise) => {
      listeners.set(requestId, (data) => {
        if (data.type === 'analysis-update') return;
        listeners.delete(requestId);
        if (data.type === 'analysis') resolvePromise(data.analysis);
        else rejectPromise(new Error(data.message ?? 'analysis failed'));
      });
      onMessage({ data: { type: 'analyze', requestId, position, options: engineOptions } });
    });
  };
};

const MODE_ROWS = {
  V1: [
    '.........', '.........', '.........',
    '.R.....s.', '.P.....p.', '.S.....r.',
    '.........', '.........', '.........',
  ],
  LARGE: [
    '...SSS...', '...PPP...', '...RRR...',
    '.........', '.........', '.........',
    '...rrr...', '...ppp...', '...sss...',
  ],
};

// The arena needs a mode object shaped like the server's catalog entry. Only
// the id and the starting rows matter to the rules module.
const MODES = {
  V1: { id: 'V1', name: 'Annihilation', startingPosition: { rows: MODE_ROWS.V1 } },
  V5: { id: 'V5', name: 'Total War', startingPosition: { rows: MODE_ROWS.LARGE } },
  V3: { id: 'V3', name: 'Infiltration', startingPosition: { rows: MODE_ROWS.LARGE } },
};

const pad = (value, width) => String(value).padStart(width);

const main = async () => {
  const analyze = await startWorker();
  const { createBot } = await import('../engine/botEngine.js');
  const { BOT_PROFILES, botProfile } = await import('../engine/botProfiles.js');
  const { createSeededRandom, playBotMatch } = await import('../engine/botArena.js');

  const pairs = Number(argument('pairs', 25));
  const seed = Number(argument('seed', 1));
  const openingPlies = Number(argument('opening', 6));
  const modeArgument = argument('mode', 'all');
  const modeIds = modeArgument === 'all' ? ['V1', 'V5', 'V3'] : modeArgument.split(',');

  if (flag('spread')) {
    await reportSpread({ analyze, modeIds, MODES, seed });
    return;
  }

  if (flag('selftest')) {
    await runSelfTest({ analyze, createBot, modeIds, pairs, playBotMatch, seed });
    return;
  }

  // Each rung against the one below it, stronger side first so a healthy
  // ladder reads as a column of positive Elo.
  const matchups = flag('ladder')
    ? BOT_PROFILES.slice(1).map((profile, index) => [profile.id, BOT_PROFILES[index].id])
    : [[argument('a', 'boulder'), argument('b', 'snips')]];

  console.log(
    `pairs ${pairs} per mode (${pairs * 2} games), opening ${openingPlies} plies, seed ${seed}\n`,
  );

  for (const [aId, bId] of matchups) {
    const aProfile = botProfile(aId);
    const bProfile = botProfile(bId);
    console.log(`${aProfile.name} vs ${bProfile.name}`);
    for (const modeId of modeIds) {
      const mode = MODES[modeId];
      const started = performance.now();
      // Both bots are rebuilt per game from the pair seed, so the two colour
      // assignments of one opening see identical random streams.
      const buildBots = (pairSeed) => ({
        firstBot: createBot(aProfile, {
          analyze,
          random: createSeededRandom(pairSeed * 31 + 7),
          sleep: () => Promise.resolve(),
        }),
        secondBot: createBot(bProfile, {
          analyze,
          random: createSeededRandom(pairSeed * 7919 + 13),
          sleep: () => Promise.resolve(),
        }),
      });
      const result = await playBotMatch({
        // Off unless asked for: the app never lets a bot resign against a
        // person, so a recorded number must not come from one that did.
        adjudicateResignations: flag('adjudicate'),
        buildBots,
        mode,
        openingPlies,
        pairs,
        seed,
      });
      const { elo, eloHigh, eloLow, games, score } = result.statistics;
      const reasons = Object.entries(result.endReasons)
        .sort((a, b) => b[1] - a[1])
        .map(([reason, count]) => `${reason} ${count}`)
        .join(', ');
      console.log(
        `  ${mode.name.padEnd(13)} ${pad(result.firstBotWins, 3)}W ${pad(result.draws, 3)}D` +
          ` ${pad(result.secondBotWins, 3)}L  score ${score.toFixed(4)}` +
          `  elo ${pad(elo.toFixed(0), 5)} [${eloLow.toFixed(0)}, ${eloHigh.toFixed(0)}]` +
          `  ${((performance.now() - started) / 1000).toFixed(0)}s  n=${games}`,
      );
      console.log(`  ${' '.repeat(13)} ends: ${reasons}`);
    }
    console.log('');
  }
};

// The arena's own sanity check.
//
// A profile that samples nothing is a deterministic function of the position,
// so with paired openings and swapped colours it must score exactly 0.5000
// against itself, with wins and losses exactly equal. Anything else means the
// pairing is not cancelling what it claims to cancel. Kept shallow because
// this tests the harness, not the engine.
const runSelfTest = async ({ analyze, createBot, modeIds, pairs, playBotMatch, seed }) => {
  const deterministic = {
    id: 'selftest',
    name: 'Selftest',
    rating: 0,
    blurb: '',
    search: { maxDepth: 4, maxTimeMs: 5_000 },
    choice: { candidateLines: 1, maxLossUnits: 0, randomMoveChance: 0, temperatureUnits: 0 },
    tempo: { minThinkMs: 0, maxThinkMs: 0 },
    manners: {
      resignBelowArmies: null,
      resignAfterMove: 0,
      acceptDrawWithinArmies: 0,
      acceptDrawAfterMove: 0,
    },
  };
  let failures = 0;
  console.log('selftest: a deterministic profile against itself\n');
  for (const modeId of modeIds) {
    const mode = MODES[modeId];
    const result = await playBotMatch({
      buildBots: () => ({
        firstBot: createBot(deterministic, { analyze, sleep: () => Promise.resolve() }),
        secondBot: createBot(deterministic, { analyze, sleep: () => Promise.resolve() }),
      }),
      mode,
      openingPlies: 6,
      pairs,
      seed,
    });
    const balanced =
      result.firstBotWins === result.secondBotWins &&
      Math.abs(result.statistics.score - 0.5) < 1e-9;
    if (!balanced) failures += 1;
    console.log(
      `  ${mode.name.padEnd(13)} ${pad(result.firstBotWins, 3)}W ${pad(result.draws, 3)}D` +
        ` ${pad(result.secondBotWins, 3)}L  score ${result.statistics.score.toFixed(4)}` +
        `  ${balanced ? 'ok' : 'MISMATCH'}`,
    );
  }
  if (failures > 0) {
    console.error(`\nselftest failed in ${failures} mode(s).`);
    process.exitCode = 1;
  }
};

// Root-score gaps decide what the choice knobs can possibly do: a temperature
// far larger than the gaps makes every candidate equally likely, and a
// guardrail far larger than the gaps never fires.
const reportSpread = async ({ analyze, modeIds, MODES: modes, seed }) => {
  const { enginePosition } = await import('../engine/analysisGame.js');
  const { createSeededRandom, randomOpening } = await import('../engine/botArena.js');
  const depth = Number(argument('depth', 6));
  const samples = Number(argument('samples', 120));

  console.log(`root-score gaps, depth ${depth}, ${samples} random openings per mode\n`);
  for (const modeId of modeIds) {
    const mode = modes[modeId];
    const random = createSeededRandom(seed);
    const gaps3 = [];
    const gaps8 = [];
    for (let index = 0; index < samples; index += 1) {
      const opening = randomOpening(mode, [4, 8, 14, 20, 30][index % 5], random);
      if (!opening) continue;
      const analysis = await analyze(
        { ...enginePosition(opening.game), history: opening.history.map(enginePosition) },
        { maxDepth: depth, maxNodes: 400_000, maxTimeMs: 10_000, throttleMs: 0, variations: 8 },
      );
      const lines = analysis?.lines ?? [];
      if (lines.length < 8) continue;
      if (lines.some((line) => Math.abs(line.score) > 20_000)) continue;
      gaps3.push(lines[0].score - lines[2].score);
      gaps8.push(lines[0].score - lines[7].score);
    }
    const at = (values, p) =>
      values.length === 0 ? 0 : values.slice().sort((a, b) => a - b)[Math.round((values.length - 1) * p)];
    console.log(`${mode.name}  n=${gaps3.length}`);
    console.log(`  top1-top3  median ${pad(at(gaps3, 0.5), 4)}  p90 ${pad(at(gaps3, 0.9), 4)}`);
    console.log(`  top1-top8  median ${pad(at(gaps8, 0.5), 4)}  p90 ${pad(at(gaps8, 0.9), 4)}`);
  }
};

await main();
