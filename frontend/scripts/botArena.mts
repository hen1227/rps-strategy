// Measure the bot ladder headlessly, against the engine build that ships.
//
// usage:
//   npm run arena -- --ladder --pairs 25
//   npm run arena -- --a crane --b boulder --mode V3 --pairs 40
//   npm run arena -- --a racer --b snips --mode V3   (the searchless racer)
//   npm run arena -- --spread            (root-score gaps per mode)
//   npm run arena -- --ladder --adjudicate   (faster, less faithful)
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

import { performance } from 'node:perf_hooks';

import { startEngineWorker } from './engineWorker.mts';
import { enginePosition } from '../src/engine/analysisGame';
import {
  createSeededRandom,
  playBotMatch,
  randomOpening,
  type BuildBots,
} from '../src/engine/bots/arena';
import { createBot, type Bot } from '../src/engine/bots/engine';
import { BOT_PROFILES, botProfile, type BotProfile } from '../src/engine/bots/profiles';
import { RACER_PROFILE, createRacerBot } from '../src/engine/bots/racer';
import { RACER_DEFAULTS, type RacerOptions } from '../src/engine/racer';
import { supportsReachRace } from '../src/engine/reach';
import { testMode } from '../src/testing/modes';
import type { ModeDefinition, ModeID } from '../src/types/game';
import type { AnalyzeFn } from '../src/engine/rpsfish/client';

const argument = (name: string, fallback: string) => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] && !process.argv[index + 1].startsWith('--')
    ? process.argv[index + 1]
    : fallback;
};
const flag = (name: string) => process.argv.includes(`--${name}`);

// The arena needs a mode object shaped like the server's catalog entry. Only
// the id and the starting rows matter to the rules module, so these come from
// the shared fixtures rather than being restated.
const MODES: Record<string, ModeDefinition> = {
  V5: testMode('V5'),
  V3: testMode('V3'),
  V6: testMode('V6'),
};

const modeOf = (modeId: string): ModeDefinition => {
  const mode = MODES[modeId];
  if (!mode) throw new Error(`${modeId} is not a mode this arena knows.`);
  return mode;
};

const pad = (value: string | number, width: number) => String(value).padStart(width);

// The racer is not a rung of the ladder — see `bots/racer.ts` — so it is
// resolved here rather than through `botProfile`, which answers an unknown id
// with the default rung instead of an error.
//
// Its own switches ride on the id as `racer:blind:vacates`, so an ablation is a
// matchup rather than a second script: `--a racer --b racer:blind` prices the
// capture guard, and the two sides of `--a racer --b racer` must draw exactly
// half, because a racer with no randomness in it is a function of the position.
const isRacer = (id: string) => id === RACER_PROFILE.id || id.startsWith(`${RACER_PROFILE.id}:`);

const racerOptions = (id: string): RacerOptions => ({
  ...RACER_DEFAULTS,
  answerCaptures: !id.includes(':blind'),
  obstacles: id.includes(':vacates') ? 'friendlyVacates' : RACER_DEFAULTS.obstacles,
});

const contender = (id: string): BotProfile =>
  isRacer(id) ? { ...RACER_PROFILE, name: id === RACER_PROFILE.id ? RACER_PROFILE.name : id } : botProfile(id);

const buildContender = (id: string, analyze: AnalyzeFn, seed: number): Bot =>
  isRacer(id)
    ? createRacerBot({ racer: racerOptions(id) })
    : createBot(botProfile(id), {
        analyze,
        random: createSeededRandom(seed),
        sleep: () => Promise.resolve(),
      });

const main = async () => {
  const { analyze } = await startEngineWorker();

  const pairs = Number(argument('pairs', '25'));
  const seed = Number(argument('seed', '1'));
  const openingPlies = Number(argument('opening', '6'));
  const modeArgument = argument('mode', 'all');
  const modeIds = modeArgument === 'all' ? ['V5', 'V3', 'V6'] : modeArgument.split(',');

  if (flag('spread')) {
    await reportSpread({ analyze, modeIds, seed });
    return;
  }

  if (flag('selftest')) {
    await runSelfTest({ analyze, modeIds, pairs, seed });
    return;
  }

  // Each rung against the one below it, stronger side first so a healthy
  // ladder reads as a column of positive Elo.
  const matchups: [string, string][] = flag('ladder')
    ? BOT_PROFILES.slice(1).map((profile, index) => [
        profile.id,
        BOT_PROFILES[index]?.id ?? profile.id,
      ])
    : [[argument('a', 'boulder'), argument('b', 'snips')]];

  console.log(
    `pairs ${pairs} per mode (${pairs * 2} games), opening ${openingPlies} plies, seed ${seed}\n`,
  );

  for (const [aId, bId] of matchups) {
    const aProfile = contender(aId);
    const bProfile = contender(bId);
    console.log(`${aProfile.name} vs ${bProfile.name}`);
    for (const modeId of modeIds) {
      const mode = modeOf(modeId);
      if ((isRacer(aId) || isRacer(bId)) && !supportsReachRace(modeId)) {
        console.log(`  ${mode.name.padEnd(13)} skipped: the racer only plays Infiltration.`);
        continue;
      }
      const started = performance.now();
      // Both bots are rebuilt per game from the pair seed, so the two colour
      // assignments of one opening see identical random streams.
      const buildBots: BuildBots = (pairSeed) => ({
        firstBot: buildContender(aId, analyze, pairSeed * 31 + 7),
        secondBot: buildContender(bId, analyze, pairSeed * 7919 + 13),
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
const runSelfTest = async ({
  analyze,
  modeIds,
  pairs,
  seed,
}: {
  analyze: AnalyzeFn;
  modeIds: string[];
  pairs: number;
  seed: number;
}) => {
  const deterministic: BotProfile = {
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
    const mode = modeOf(modeId);
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
const reportSpread = async ({
  analyze,
  modeIds,
  seed,
}: {
  analyze: AnalyzeFn;
  modeIds: string[];
  seed: number;
}) => {
  const depth = Number(argument('depth', '6'));
  const samples = Number(argument('samples', '120'));

  console.log(`root-score gaps, depth ${depth}, ${samples} random openings per mode\n`);
  const OPENING_LENGTHS = [4, 8, 14, 20, 30];
  for (const modeId of modeIds) {
    const mode = modeOf(modeId);
    const random = createSeededRandom(seed);
    const gaps3: number[] = [];
    const gaps8: number[] = [];
    for (let index = 0; index < samples; index += 1) {
      const opening = randomOpening(
        mode,
        OPENING_LENGTHS[index % OPENING_LENGTHS.length] ?? 6,
        random,
      );
      if (!opening) continue;
      const analysis = await analyze(
        { ...enginePosition(opening.game), history: opening.history.map(enginePosition) },
        { maxDepth: depth, maxNodes: 400_000, maxTimeMs: 10_000, throttleMs: 0, variations: 8 },
      );
      const lines = analysis?.lines ?? [];
      const [best, , third, , , , , eighth] = lines;
      if (!best || !third || !eighth) continue;
      if (lines.some((line) => Math.abs(line.score) > 20_000)) continue;
      gaps3.push(best.score - third.score);
      gaps8.push(best.score - eighth.score);
    }
    const at = (values: number[], p: number) =>
      values.length === 0
        ? 0
        : (values.slice().sort((a, b) => a - b)[Math.round((values.length - 1) * p)] ?? 0);
    console.log(`${mode.name}  n=${gaps3.length}`);
    console.log(`  top1-top3  median ${pad(at(gaps3, 0.5), 4)}  p90 ${pad(at(gaps3, 0.9), 4)}`);
    console.log(`  top1-top8  median ${pad(at(gaps8, 0.5), 4)}  p90 ${pad(at(gaps8, 0.9), 4)}`);
  }
};

await main();
