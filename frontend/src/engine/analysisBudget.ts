// How hard the client is allowed to think, worked out rather than asked.
//
// Analysis used to open with a question: Standard or Deep? It is not a question
// a reviewer can answer — the honest answer depends on the machine they are
// holding, which they cannot see, and on how long the game is, which they have
// not counted. So nothing asks it any more. A search runs as deep as the device
// can manage inside a sensible wait, and deepens while you watch.
//
// Two things decide that, and only one of them is a guess:
//
//   1. A coarse device tier, from what the platform will admit to. It sets
//      ceilings only: how many rungs the ladder has and how long the whole
//      walk may take.
//   2. Measurement. The session in `gameAnalysis.ts` times each completed pass
//      and climbs to the next rung only when the time that pass took says the
//      next one will fit. That is what actually adapts to the device, which is
//      why the tier can afford to be crude.
//
// The one control left is QUICK, for a reviewer who wants a number now and does
// not care that a deeper search might revise it. It is a single shallow pass
// with no deepening — see `analysisLadder`.

import { Platform } from 'react-native';

import { ANALYSIS_PRESETS, REVIEW_PRESETS } from './rpsfish/client';
import type { SearchLimits } from './rpsfish/protocol';

/** How much of the device the reviewer is willing to spend. */
export type AnalysisEffort = 'quick' | 'full';

export const DEFAULT_ANALYSIS_EFFORT: AnalysisEffort = 'full';

/**
 * What the machine will admit to being able to do.
 *
 * Deliberately three buckets. A finer reading would be a false precision: the
 * numbers a browser reports are core count and a rounded memory figure, neither
 * of which says anything about how fast a core is, and the native app reports
 * neither. The real measurement happens in the walk itself.
 */
export type DeviceTier = 'low' | 'medium' | 'high';

const detectTier = (): DeviceTier => {
  // The iOS app runs the engine natively, on a device that is thermally and
  // battery limited and has no API for either. Middle of the road, always:
  // a phone that can do better proves it by finishing a pass quickly.
  if (Platform.OS !== 'web') return 'medium';
  const nav =
    typeof navigator === 'undefined'
      ? undefined
      : (navigator as { hardwareConcurrency?: number; deviceMemory?: number });
  const cores = nav?.hardwareConcurrency ?? 4;
  // Only Chromium reports this, and it is rounded down to a power of two. Absent
  // means unknown, not small, so it can only ever hold a tier back.
  const memory = nav?.deviceMemory ?? Infinity;
  if (cores >= 8 && memory >= 8) return 'high';
  if (cores >= 4 && memory >= 4) return 'medium';
  return 'low';
};

let cachedTier: DeviceTier | null = null;

/** The tier, measured once. Nothing it reads can change while the app is open. */
export const deviceTier = (): DeviceTier => {
  cachedTier ??= detectTier();
  return cachedTier;
};

/** Forget the cached tier. For tests, which need to ask as several devices. */
export const resetDeviceTier = () => {
  cachedTier = null;
};

/**
 * A rung of the ladder that is deeper than anything a preset offered.
 *
 * The old Deep — depth 12, eight seconds — was the deepest a reviewer could
 * ask for because it was the longest wait worth putting behind a button. It is
 * no longer the longest wait, because nobody waits for it: the report is
 * already on screen at a shallower depth when this pass starts, and this pass
 * only ever replaces it with better numbers.
 */
const DEEPER: SearchLimits = {
  maxDepth: 16,
  maxNodes: 20_000_000,
  maxTimeMs: 20_000,
  throttleMs: 0,
  variations: 3,
};

const REVIEW_RUNGS: readonly SearchLimits[] = [
  REVIEW_PRESETS.fast,
  REVIEW_PRESETS.standard,
  REVIEW_PRESETS.deep,
  DEEPER,
];

/** How many review rungs a tier is allowed to climb. */
const REVIEW_REACH: Record<DeviceTier, number> = { low: 2, medium: 3, high: 4 };

export interface LadderOptions {
  effort?: AnalysisEffort;
  /**
   * Whether the game is still being played. A live game is graded against
   * players who are themselves searching, so its floor is higher — see below.
   */
  live?: boolean;
  tier?: DeviceTier;
}

/**
 * The budgets a walk will climb, weakest first.
 *
 * A finished game starts shallow on purpose. The first pass exists to put
 * grades on the screen in a second or two; every pass after it exists to make
 * them right, and the reviewer sees each one replace the last.
 *
 * A game still being played cannot start shallow. Its moves are being chosen by
 * searches of their own, and grading a move against a weaker search than the one
 * that chose it measures the player against nothing — `docs/review.md` sets out
 * at length why that is not a real option. So a live walk's floor is Deep, the
 * budget it used when this was a switch, and it climbs from there only once the
 * board stops moving. QUICK is the reviewer overriding that knowingly.
 */
export const analysisLadder = ({
  effort = DEFAULT_ANALYSIS_EFFORT,
  live = false,
  tier = deviceTier(),
}: LadderOptions = {}): readonly SearchLimits[] => {
  if (effort === 'quick') return live ? [REVIEW_PRESETS.standard] : [REVIEW_PRESETS.fast];
  if (live) return tier === 'high' ? [REVIEW_PRESETS.deep, DEEPER] : [REVIEW_PRESETS.deep];
  return REVIEW_RUNGS.slice(0, REVIEW_REACH[tier]);
};

/** How long the whole walk may take, every pass together. */
const REVIEW_BUDGET_MS: Record<DeviceTier, number> = {
  low: 35_000,
  medium: 60_000,
  high: 90_000,
};

/**
 * The wall clock the walk has to climb its ladder in.
 *
 * Only ever spent on deepening. The first pass runs to completion whatever this
 * says — a review with no grades in it is not a review — so this is the answer
 * to "how long may it keep improving", not "how long may it take".
 */
export const analysisBudgetMs = ({
  effort = DEFAULT_ANALYSIS_EFFORT,
  tier = deviceTier(),
}: Omit<LadderOptions, 'live'> = {}): number =>
  effort === 'quick' ? 0 : REVIEW_BUDGET_MS[tier];

/** How long a settled walk waits before spending time on a deeper pass. */
export const ANALYSIS_SETTLE_MS = 1_200;

// Iterative deepening streams every completed depth, so the interactive search
// is never waiting on its ceiling to be useful: the arrows are drawn from the
// first depth that lands and redrawn as each deeper one does. That makes a long
// ceiling close to free — it costs a background worker, not the reviewer's
// attention — and it is abandoned the moment the position changes.
const INTERACTIVE_FULL: Record<DeviceTier, SearchLimits> = {
  low: { ...ANALYSIS_PRESETS.deep, maxNodes: 12_000_000, maxTimeMs: 6_000 },
  medium: { ...ANALYSIS_PRESETS.deep, maxNodes: 40_000_000, maxTimeMs: 12_000 },
  high: { ...ANALYSIS_PRESETS.deep, maxTimeMs: 20_000 },
};

const INTERACTIVE_QUICK: SearchLimits = { ...ANALYSIS_PRESETS.standard, maxTimeMs: 1_200 };

/**
 * The budget for the search behind the arrows, the eval bar and the ranked
 * lines on a board somebody is clicking around.
 */
export const interactiveLimits = ({
  effort = DEFAULT_ANALYSIS_EFFORT,
  tier = deviceTier(),
}: Omit<LadderOptions, 'live'> = {}): SearchLimits =>
  effort === 'quick' ? INTERACTIVE_QUICK : INTERACTIVE_FULL[tier];
