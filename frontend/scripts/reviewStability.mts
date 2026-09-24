// Measure how much RPSFish disagrees with itself about a move.
//
// The review prints a grade in a confident badge. A badge is only worth
// printing if a deeper search would have said the same thing, so this measures
// how often it would not: take games, grade every one at every rung of the
// shipped ladder, and compare each move's verdict rung by rung against the
// deepest one available.
//
// It answers two separate questions, and they have different answers:
//
//   1. How far off is the *loss number*? That sets `ENGINE_LOSS_ERROR_BAR` and
//      `ENGINE_LOSS_ERROR_TAIL` in `src/engine/gameReview.ts`, which the grade
//      bands are required to clear.
//   2. How often does the *badge* change? That is the number the bands are
//      answerable to, and it is far worse than (1) if the bands are drawn in
//      the wrong place. Both band schemes are scored on the same positions so
//      a change can be shown to be an improvement rather than asserted to be.
//
// Re-run it after an evaluation change, the same way `reviewCalibration.mts`
// is re-run, and for the same reason: these are measurements of a particular
// engine build, not preferences.
//
// **Measure real games.** Pass `--pgn` a directory of archived records —
// `GET /api/games/{id}/pgn` fetches them. The synthetic games this falls back
// to are much quieter than real ones and will validate almost any scheme; see
// `playGame`.
//
// usage:
//   npm run measure:stability -- --pgn ./records --mode V3
//   npm run measure:stability -- --pgn ./records --mode V5 --top deep
//   npm run measure:stability -- --games 12 --mode V5          # synthetic

import { performance } from 'node:perf_hooks';

import { startEngineWorker } from './engineWorker.mts';
import {
  allValidMoves,
  applyAnalysisMove,
  createAnalysisGame,
  enginePosition,
  type EnginePosition,
} from '../src/engine/analysisGame';
import { REVIEW_PRESETS } from '../src/engine/rpsfish/client';
import { MOVE_GRADES, reviewSourceFromPGN, winPercent } from '../src/engine/gameReview';
import type { SearchLimits } from '../src/engine/rpsfish/protocol';
import { testMode } from '../src/testing/modes';
import type { ModeDefinition, ModeID } from '../src/types/game';

const argument = (name: string, fallback = '') => {
  const index = process.argv.indexOf(`--${name}`);
  const value = process.argv[index + 1];
  return index >= 0 && value && !value.startsWith('--') ? value : fallback;
};

const MODES: Record<string, ModeDefinition> = {
  V5: testMode('V5'),
  V3: testMode('V3'),
  V6: testMode('V6'),
};

const modeOf = (modeId: string): ModeDefinition => {
  const mode = MODES[modeId];
  if (!mode) throw new Error(`${modeId} is not a mode this script knows.`);
  return mode;
};

// The ladder the review actually climbs, plus the rung above it. The top rung
// is the reference: not "the truth", but the best opinion this engine has, and
// the only standard a shallower rung can be held to.
const DEEPER: SearchLimits = {
  maxDepth: 16,
  maxNodes: 20_000_000,
  maxTimeMs: 20_000,
  throttleMs: 0,
  variations: 3,
};
const ALL_RUNGS: readonly { name: string; limits: SearchLimits }[] = [
  { name: 'quick', limits: REVIEW_PRESETS.fast },
  { name: 'standard', limits: REVIEW_PRESETS.standard },
  { name: 'deep', limits: REVIEW_PRESETS.deep },
  { name: 'deeper', limits: DEEPER },
];

/**
 * The rungs to compare, with the last one as the reference.
 *
 * `--top deep` stops at the Deep rung, which is both much cheaper to measure
 * and the top rung an ordinary device ever reaches: `REVIEW_REACH` in
 * `analysisBudget.ts` gives a `low` device two rungs and a `medium` one three,
 * so only a `high` device ever sees a Deeper grade at all. The badge most
 * people read comes off Standard or Deep.
 */
const rungsUpTo = (top: string) => {
  const at = ALL_RUNGS.findIndex((rung) => rung.name === top);
  if (at < 1) throw new Error(`${top} is not a rung this script can stop at.`);
  return ALL_RUNGS.slice(0, at + 1);
};

const seededRandom = (seed: number) => {
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
 * Play one game that looks like a game somebody would review.
 *
 * A fallback, and a poor one. Moves are drawn from the whole legal move list
 * with a bias toward the engine's own shallow choice, which was meant to stand
 * in for a mid-strength player. It does not: measured against real archived
 * games, synthetic Total War games come out four times quieter at every
 * quantile of loss, because a random legal move in a slow position usually
 * costs nothing and the game never sharpens. A band scheme validated only
 * against these would look fine and be wrong.
 *
 * So prefer `--pgn`, which measures real games. This is here for a mode with
 * no archive to read, and for a quick smoke test of the script itself.
 */
const playGame = async ({
  analyze,
  mode,
  plies,
  random,
  strength,
}: {
  analyze: Awaited<ReturnType<typeof startEngineWorker>>['analyze'];
  mode: ModeDefinition;
  plies: number;
  random: () => number;
  /** How often the player plays its own shallow choice rather than anything legal. */
  strength: number;
}) => {
  let game = createAnalysisGame(mode);
  const positions = [game];
  const moves: { from: { x: number; y: number }; to: { x: number; y: number } }[] = [];
  for (let ply = 0; ply < plies && game.status === 'InProgress'; ply += 1) {
    const legal = allValidMoves(game);
    if (legal.length === 0) break;
    // A shallow search stands in for the player's own thinking. Deliberately
    // shallower than any review rung: the point is to produce a game with
    // mistakes in it, not to produce the engine's best game.
    const roll = random();
    let chosen: { from: { x: number; y: number }; to: { x: number; y: number } } | undefined;
    if (roll < strength) {
      const analysis = await analyze(
        { ...enginePosition(game), history: positions.slice(0, -1).map(enginePosition) },
        { maxDepth: 4, maxNodes: 60_000, maxTimeMs: 250, throttleMs: 0, variations: 1 },
      );
      const top = analysis.lines[0];
      if (top) chosen = { from: top.from, to: top.to };
    }
    chosen ??= legal[Math.floor(random() * legal.length)];
    if (!chosen) break;
    const played = applyAnalysisMove(game, chosen.from, chosen.to);
    if (!played) break;
    moves.push({ from: chosen.from, to: chosen.to });
    game = played.game;
    positions.push(game);
  }
  return { positions, moves, finished: game.status === 'Finished' };
};

/** One game to grade, however it was obtained. */
interface Subject {
  label: string;
  positions: EnginePosition[];
  moves: { from: { x: number; y: number }; to: { x: number; y: number } }[];
}

/**
 * Archived games, read off disk and replayed with the frontend's own rules.
 *
 * Records are what the review actually runs on, so they are the right thing to
 * measure. Pass a directory of `.pgn` files or a single one; fetch them from
 * the archive with `GET /api/games/{id}/pgn`. A record in another mode is
 * skipped rather than coerced, and so is one the replay cannot follow —
 * usually a rules era this build no longer implements, which is a fact about
 * the archive rather than a failure here.
 */
const readArchive = async (path: string, mode: ModeDefinition): Promise<Subject[]> => {
  const { readdir, readFile, stat } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const info = await stat(path);
  const files = info.isDirectory()
    ? (await readdir(path)).filter((name) => name.endsWith('.pgn')).map((name) => join(path, name))
    : [path];
  const subjects: Subject[] = [];
  for (const file of files) {
    const text = await readFile(file, 'utf8');
    try {
      const source = reviewSourceFromPGN(text, Object.values(MODES));
      if (source.mode.id !== mode.id) continue;
      if (source.moves.length < 10) continue;
      subjects.push({
        label: file.split('/').pop() ?? file,
        positions: source.positions.map(enginePosition),
        moves: source.moves.map((move) => ({ from: move.from, to: move.to })),
      });
    } catch (error) {
      console.log(`  skipped ${file.split('/').pop()}: ${(error as Error).message}`);
    }
  }
  return subjects;
};

const quantile = (sorted: number[], q: number) => {
  if (sorted.length === 0) return 0;
  const at = (sorted.length - 1) * q;
  const low = Math.floor(at);
  const high = Math.ceil(at);
  const lowValue = sorted[low] ?? 0;
  const highValue = sorted[high] ?? lowValue;
  return lowValue + (highValue - lowValue) * (at - low);
};

const pct = (value: number) => `${(value * 100).toFixed(1)}%`;

/**
 * Two band schemes, scored side by side.
 *
 * `shipped` is read out of `gameReview.ts`, so this measures what the app
 * actually does. `legacy` is what it did before the bands were re-derived from
 * the accuracy curve, kept here because the only way to claim the change was
 * an improvement is to score both on the same positions.
 */
const SCHEMES: readonly { name: string; bands: readonly { key: string; maxLoss: number }[] }[] = [
  {
    name: 'legacy 2/5/10/20',
    bands: [
      { key: 'excellent', maxLoss: 2 },
      { key: 'good', maxLoss: 5 },
      { key: 'inaccuracy', maxLoss: 10 },
      { key: 'mistake', maxLoss: 20 },
      { key: 'blunder', maxLoss: Infinity },
    ],
  },
  {
    name: 'shipped',
    bands: MOVE_GRADES.filter(
      (grade) => grade.key !== 'best' && grade.key !== 'great',
    ).map((grade) => ({ key: grade.key, maxLoss: grade.maxLoss })),
  },
];

const bandOf = (
  bands: readonly { key: string; maxLoss: number }[],
  loss: number,
) => bands.find((band) => loss <= band.maxLoss)?.key ?? 'blunder';

const CONDEMNING = new Set(['mistake', 'blunder']);

const main = async () => {
  const { analyze, review } = await startEngineWorker();

  const games = Number(argument('games', '8'));
  const plies = Number(argument('plies', '160'));
  const seed = Number(argument('seed', '20260914'));
  const modeIds = argument('mode', 'V5,V3').split(',');
  // How strong the players are. Lower puts more moves into the bands that
  // actually get condemned, which is where the flip rate matters.
  const strength = Number(argument('strength', '0.6'));
  const RUNGS = rungsUpTo(argument('top', 'deeper'));
  // A directory of archived `.pgn` records, or one file. Real games when there
  // are any; see `playGame` for why the synthetic ones are a poor substitute.
  const archive = argument('pgn');
  const referenceName = RUNGS[RUNGS.length - 1]?.name ?? 'deeper';

  console.log(
    archive
      ? `archived records from ${archive}`
      : `${games} synthetic games per mode, up to ${plies} plies, seed ${seed}, strength ${strength}`,
  );
  console.log(
    `rungs: ${RUNGS.map((rung) => `${rung.name}(d${rung.limits.maxDepth})`).join(' ')}\n`,
  );

  for (const modeId of modeIds) {
    const mode = modeOf(modeId);
    const started = performance.now();
    // losses[rungName][moveKey] — one number per move per rung.
    const losses = new Map<string, number[]>();
    const topAgreement = new Map<string, boolean[]>();
    for (const rung of RUNGS) {
      losses.set(rung.name, []);
      topAgreement.set(rung.name, []);
    }

    const subjects: Subject[] = archive
      ? (await readArchive(archive, mode)).slice(0, games)
      : await (async () => {
          const built: Subject[] = [];
          for (let index = 0; index < games; index += 1) {
            const game = await playGame({
              analyze,
              mode,
              plies,
              strength,
              random: seededRandom(seed + index * 7919),
            });
            if (game.moves.length < 10) continue;
            built.push({
              label: `synthetic ${index + 1}`,
              positions: game.positions.map(enginePosition),
              moves: game.moves,
            });
          }
          return built;
        })();
    if (subjects.length === 0) {
      console.log(`  ${modeId}: nothing to grade\n`);
      continue;
    }

    let totalMoves = 0;
    for (const [index, game] of subjects.entries()) {
      totalMoves += game.moves.length;
      for (const rung of RUNGS) {
        const entries = await review({
          positions: game.positions,
          moves: game.moves,
          options: rung.limits,
        });
        const lossList = losses.get(rung.name) ?? [];
        const topList = topAgreement.get(rung.name) ?? [];
        for (let ply = 0; ply < game.moves.length; ply += 1) {
          const entry = entries[ply];
          const played = game.moves[ply];
          if (!entry || entry.playedScore === null || !played) {
            lossList.push(Number.NaN);
            topList.push(false);
            continue;
          }
          const before = winPercent(entry.baselineScore, modeId as ModeID);
          const after = winPercent(entry.playedScore, modeId as ModeID);
          lossList.push(Math.max(0, before - after));
          const top = entry.analysis.lines[0];
          topList.push(
            Boolean(
              top &&
                top.from.x === played.from.x &&
                top.from.y === played.from.y &&
                top.to.x === played.to.x &&
                top.to.y === played.to.y,
            ),
          );
        }
      }
      process.stdout.write(
        `  ${modeId}: ${index + 1}/${subjects.length} ${game.label}, ${
          game.moves.length
        } moves            \r`,
      );
    }

    const reference = losses.get(referenceName) ?? [];
    const referenceTop = topAgreement.get(referenceName) ?? [];
    console.log(`\n${mode.name ?? modeId} (${modeId}) — ${totalMoves} moves, ${(
      (performance.now() - started) /
      1000
    ).toFixed(0)}s\n`);

    console.log(`  |Δloss| vs ${referenceName}, and how often the engine's own first line changes`);
    console.log('  rung      median   p75   p90   p95   best-move disagreement');
    for (const rung of RUNGS) {
      if (rung.name === referenceName) continue;
      const mine = losses.get(rung.name) ?? [];
      const deltas: number[] = [];
      let compared = 0;
      let bestMoveDisagreements = 0;
      for (let at = 0; at < reference.length; at += 1) {
        const theirs = reference[at];
        const ours = mine[at];
        if (theirs === undefined || ours === undefined) continue;
        if (!Number.isFinite(theirs) || !Number.isFinite(ours)) continue;
        compared += 1;
        deltas.push(Math.abs(ours - theirs));
        if ((topAgreement.get(rung.name) ?? [])[at] !== referenceTop[at]) {
          bestMoveDisagreements += 1;
        }
      }
      deltas.sort((left, right) => left - right);
      console.log(
        `  ${rung.name.padEnd(9)} ${quantile(deltas, 0.5).toFixed(1).padStart(6)} ${quantile(
          deltas,
          0.75,
        )
          .toFixed(1)
          .padStart(5)} ${quantile(deltas, 0.9).toFixed(1).padStart(5)} ${quantile(deltas, 0.95)
          .toFixed(1)
          .padStart(5)}   ${pct(bestMoveDisagreements / Math.max(1, compared))}`,
      );
    }

    // The number the bands are answerable to: how often a badge a reader was
    // shown is one the engine itself overturns on a deeper look.
    console.log('\n  badges a deeper search overturns');
    console.log(
      '  scheme              rung        any grade changed   condemned, then cleared   share condemned',
    );
    for (const scheme of SCHEMES) {
      for (const rung of RUNGS) {
        if (rung.name === referenceName) continue;
        const mine = losses.get(rung.name) ?? [];
        let compared = 0;
        let flips = 0;
        let condemned = 0;
        let condemnedCleared = 0;
        for (let at = 0; at < reference.length; at += 1) {
          const theirs = reference[at];
          const ours = mine[at];
          if (theirs === undefined || ours === undefined) continue;
          if (!Number.isFinite(theirs) || !Number.isFinite(ours)) continue;
          compared += 1;
          const ourBand = bandOf(scheme.bands, ours);
          const theirBand = bandOf(scheme.bands, theirs);
          if (ourBand !== theirBand) flips += 1;
          if (CONDEMNING.has(ourBand)) {
            condemned += 1;
            if (!CONDEMNING.has(theirBand)) condemnedCleared += 1;
          }
        }
        console.log(
          `  ${scheme.name.padEnd(19)} ${rung.name.padEnd(11)} ${pct(
            flips / Math.max(1, compared),
          ).padStart(15)}   ${(condemned === 0
            ? 'n/a'
            : `${pct(condemnedCleared / condemned)} of ${condemned}`
          ).padStart(23)}   ${pct(condemned / Math.max(1, compared)).padStart(14)}`,
        );
      }
    }

    // The error bar, as a function of how big the loss is. This is what sets
    // band *widths*: a boundary drawn where the engine's own disagreement is
    // +/- 6 points cannot separate two bands 5 points apart, so each band has
    // to be wider than the error bar at its own edge.
    console.log(
      `\n  error bar by size of loss (rung vs ${referenceName}, p90 of |dloss|)`,
    );
    const LOSS_BUCKETS = [0, 3, 6, 10, 15, 20, 30, 50, Infinity];
    const header = LOSS_BUCKETS.slice(0, -1)
      .map((low, at) => {
        const high = LOSS_BUCKETS[at + 1] ?? Infinity;
        return `${low}-${high === Infinity ? '+' : high}`.padStart(7);
      })
      .join('');
    console.log(`  rung      ${header}`);
    for (const rung of RUNGS) {
      if (rung.name === referenceName) continue;
      const mine = losses.get(rung.name) ?? [];
      const buckets: number[][] = LOSS_BUCKETS.slice(0, -1).map(() => []);
      for (let at = 0; at < reference.length; at += 1) {
        const theirs = reference[at];
        const ours = mine[at];
        if (theirs === undefined || ours === undefined) continue;
        if (!Number.isFinite(theirs) || !Number.isFinite(ours)) continue;
        const bucket = LOSS_BUCKETS.findIndex(
          (low, at2) => theirs >= low && theirs < (LOSS_BUCKETS[at2 + 1] ?? Infinity),
        );
        buckets[bucket]?.push(Math.abs(ours - theirs));
      }
      console.log(
        `  ${rung.name.padEnd(9)} ` +
          buckets
            .map((values) => {
              if (values.length < 8) return `${`n=${values.length}`.padStart(7)}`;
              const sorted = [...values].sort((left, right) => left - right);
              return quantile(sorted, 0.9).toFixed(1).padStart(7);
            })
            .join(''),
      );
    }

    // The distribution the bands are cutting up. A band nobody lands in is
    // furniture; a band half the game lands in is not a verdict.
    const referenceFinite = reference.filter((value) => Number.isFinite(value));
    const sorted = [...referenceFinite].sort((left, right) => left - right);
    console.log(
      `\n  loss distribution at ${referenceName}: median ${quantile(sorted, 0.5).toFixed(
        1,
      )}  p75 ${quantile(sorted, 0.75).toFixed(1)}  p90 ${quantile(sorted, 0.9).toFixed(
        1,
      )}  p99 ${quantile(sorted, 0.99).toFixed(1)}`,
    );
    for (const scheme of SCHEMES) {
      const counts = new Map<string, number>();
      for (const loss of referenceFinite) {
        const band = bandOf(scheme.bands, loss);
        counts.set(band, (counts.get(band) ?? 0) + 1);
      }
      console.log(
        `  ${scheme.name.padEnd(19)} ${scheme.bands
          .map(
            (band) =>
              `${band.key} ${pct(
                (counts.get(band.key) ?? 0) / Math.max(1, referenceFinite.length),
              )}`,
          )
          .join('  ')}`,
      );
    }
    console.log('');
  }
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
