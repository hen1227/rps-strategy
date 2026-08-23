// Every dial that decides how a bot plays lives in this file. Nothing here is
// derived from anything else, so tuning a bot means editing numbers in one
// place and reloading — no other module needs to change.
//
// A profile has four groups of knobs:
//
//   search  — how hard RPSFish is allowed to think: a depth ceiling and a
//             timeout. Whichever comes first wins, and a search the timeout
//             interrupts still returns the last fully completed depth, so a
//             short budget degrades to a shallower move rather than a bad one.
//             The node ceiling is deliberately *not* per-profile — it lives in
//             `BOT_TUNING.maxNodes` as one shared safety valve, because a
//             per-profile node cap silently caps depth instead of the depth
//             knob doing it.
//   choice  — how the bot picks among what the search found. This is where
//             weakness comes from: a weak bot searches shallowly *and* fails
//             to play the move it found.
//   tempo   — a *floor* on how long a move takes on the clock-free bot board.
//             Purely feel: an instant reply reads as a machine, a short pause
//             reads as an opponent. A search that runs longer than the floor
//             is never padded further.
//   manners — when the bot takes a draw, and the threshold below which it
//             considers itself lost. The bot board never acts on the second
//             one: a bot playing a person always plays the game out, because
//             conceding takes the win away from whoever earned it. It is used
//             only by `bots/arena.ts --adjudicate`, which is off by default.
//
// ---------------------------------------------------------------------------
// Scores are not comparable between modes, so no knob here is in raw score
// units
// ---------------------------------------------------------------------------
//
// Two knobs compare *root moves to each other* (`temperatureUnits`,
// `maxLossUnits`) and two compare *a position to level* (`resignBelowArmies`,
// `acceptDrawWithinArmies`). Those are different quantities on different
// scales, and both scales differ per mode, so each is expressed as a multiple
// of a per-mode unit in `MODE_SCORE_SCALE` rather than as a raw number.
//
// This matters more than it sounds. Measured over 600 seeded random openings
// per mode at depths 2, 4, 6 and 11 (`npm run arena -- --spread`,
// cross-checked against a native Rust run), the gap between the best root move
// and the third best has a 90th percentile of about 20 in Total War and 50 in
// Infiltration — and the *reverse* of what the material weights suggest,
// because Infiltration grades every advancing move while a quiet Total War
// position is far flatter.
//
// The knobs used to be raw centipawn numbers: temperatures from 60 to 1050 and
// guardrails from 115 to 800, against gaps whose 90th percentile is 20 in
// Total War and 50 in Infiltration. The softmax was
// therefore saturated at every rung — even Crane, the tightest sampling rung,
// gave its second choice about 90% of the weight of its first — so Pebble
// through Crane all picked close to uniformly among their candidates. The
// `maxLoss` guardrail never fired in any mode, and resignation thresholds of
// -1200 to -2400 were unreachable in every mode: the largest root score seen
// in a Total War sample was 211. Depth and `randomMoveChance` were the only live
// dials. Everything expressed per mode here exists so a number cannot silently
// mean nothing.

import type { ModeID } from '@/types/game';

/** The per-mode units every mode-relative knob below is measured in. */
export interface ModeScoreScale {
  /** Pieces per side in the mode's starting position. */
  army: number;
  /** The typical spread among the top root moves. */
  choice: number;
  /** What one piece is worth. */
  material: number;
}

// Per-mode score units. Both are properties of the mode, not of a difficulty.
//
//   choice   — the typical spread among the top root moves: the 90th
//              percentile of (best score - third best score), measured as
//              above. Stable across depth 2 to 11, so one number per mode
//              serves the whole ladder. Re-measure with `--spread` after an
//              evaluation change.
//   material — one piece, copied from `EvalParams` in
//              `RPSFish/src/evaluation.rs` (`*_material`). Duplicated rather
//              than exported across the WASM boundary; if those weights are
//              retuned, these follow.
//   army     — pieces per side in the mode's starting position, so a
//              resignation threshold can be a share of an army rather than a
//              piece count that means "nearly lost" in one mode and "still
//              fine" in another.
export const MODE_SCORE_SCALE: Partial<Record<ModeID, ModeScoreScale>> = Object.freeze({
  // Total War's `choice` was 20 until the mode's territory evaluation was
  // re-priced (RPSFish EVAL_RESULTS.md H9): a territory lead used to be worth
  // up to 1120cp on its own and is now bounded at 70, so every root score in
  // the mode is smaller and the gaps between them with it. Re-measured at 15
  // by `--spread` (p90 of best minus third best, 120 openings, depth 6). The
  // other two modes re-measured at 6 and 44 against the 7 and 50 here, which
  // is seed noise -- only `total_war_*` weights moved -- so they are left
  // alone.
  V5: Object.freeze({ army: 9, choice: 15, material: 70 }),
  V3: Object.freeze({ army: 9, choice: 50, material: 35 }),
});

// Total War's scale is the fallback: it is the narrower of the two shipped
// modes, so an unknown mode gets the more conservative reading of every knob.
const FALLBACK_SCALE: ModeScoreScale = { army: 9, choice: 15, material: 70 };

export const modeScoreScale = (modeId: ModeID | undefined): ModeScoreScale =>
  (modeId === undefined ? undefined : MODE_SCORE_SCALE[modeId]) ?? FALLBACK_SCALE;

/** How a profile picks among the moves its search returned, in mode units. */
export interface BotChoice {
  candidateLines: number;
  /** Chance of ignoring the search entirely and playing any legal move. */
  randomMoveChance: number;
  /** Softmax spread over candidate scores. 0 = always the best move. */
  temperatureUnits: number;
  /** A candidate this much worse than the best is dropped. `Infinity` = no guardrail. */
  maxLossUnits: number;
}

/** The same knobs, resolved against one mode's scale. */
export interface BotChoiceScores {
  candidateLines: number;
  maxLossCp: number;
  randomMoveChance: number;
  temperatureCp: number;
}

/** When a profile takes a draw, and when it considers itself lost. */
export interface BotManners {
  /** As a share of a starting army. `null` = never resigns. */
  resignBelowArmies: number | null;
  resignAfterMove: number;
  acceptDrawWithinArmies: number;
  acceptDrawAfterMove: number;
}

export interface BotMannersScores {
  acceptDrawWithinCp: number;
  acceptDrawAfterMove: number;
  resignAfterMove: number;
  resignBelowCp: number | null;
}

export interface BotSearchLimits {
  maxDepth: number;
  maxTimeMs: number;
}

/** A floor on how long a move takes, for feel rather than strength. */
export interface BotTempo {
  minThinkMs: number;
  maxThinkMs: number;
}

export interface BotProfile {
  id: string;
  name: string;
  rating: number;
  blurb: string;
  search: BotSearchLimits;
  choice: BotChoice;
  tempo: BotTempo;
  manners: BotManners;
}

/** Convert a profile's mode-relative choice knobs into this mode's scores. */
export const choiceScoresFor = (choice: BotChoice, modeId: ModeID | undefined): BotChoiceScores => {
  const { choice: unit } = modeScoreScale(modeId);
  return {
    candidateLines: choice.candidateLines,
    maxLossCp: choice.maxLossUnits === Infinity ? Infinity : choice.maxLossUnits * unit,
    randomMoveChance: choice.randomMoveChance,
    temperatureCp: choice.temperatureUnits * unit,
  };
};

/** Convert a profile's mode-relative manners knobs into this mode's scores. */
export const mannersScoresFor = (
  manners: BotManners,
  modeId: ModeID | undefined,
): BotMannersScores => {
  const { army, material } = modeScoreScale(modeId);
  const armyCp = army * material;
  return {
    acceptDrawWithinCp: manners.acceptDrawWithinArmies * armyCp,
    acceptDrawAfterMove: manners.acceptDrawAfterMove,
    resignAfterMove: manners.resignAfterMove,
    resignBelowCp:
      manners.resignBelowArmies === null ? null : manners.resignBelowArmies * armyCp,
  };
};

// Measured cost of the shipping ladder on this engine build (one search, an
// M4-class laptop, at the opening and 10/20 plies in). Infiltration is far
// cheaper than Total War, so the same depth ceiling behaves differently per
// mode — which is why only the top rung leans on its timeout:
//
//   rung      depth     V3 Infiltration      V5 Total War
//   Pebble       2          2 – 14 ms            1 – 2 ms
//   Napkin       3          1 –  2 ms            1 – 2 ms
//   Snips        4          2 –  3 ms            2 – 3 ms
//   Boulder      7         19 – 29 ms           14 – 22 ms
//   Crane       11        227 – 281 ms         337 – 617 ms
//   Obsidian    16        1.1 – 3.8 s      3.2 s – timeout (depth 13–16)
//   hint        14        0.6 – 1.2 s      1.3 s – timeout (depth 11–14)
//
// Everything below Crane costs less than the tempo floor, so those rungs are
// paced entirely by `tempo` and their timeouts never fire. Widening the
// candidate set costs a full-window root search per extra line, so the rungs
// that ask for eight lines are correspondingly dearer than this table; they
// are also the shallowest, which is why it stays affordable.
//
// Re-measure after an engine change: the ladder is defined in depths, so a
// faster engine makes every rung cheaper without making it stronger.

// Measured strength of this ladder, adjacent rungs only, from
// `npm run arena -- --a <rung> --b <rung below>`. Paired colour-swapped games
// from seeded random openings, 28 games per mode (24 for Boulder), games
// played out rather than adjudicated. Elo of the stronger rung over the
// weaker, with a 95% interval:
//
//   matchup             V1 (retired)      Total War         Infiltration
//   Napkin  > Pebble    +403 [235,616]    +338 [178,574]    +159 [ 30,312]
//   Snips   > Napkin    +368 [204,600]    +446 [244,800]    +226 [ 87,404]
//   Boulder > Snips     +232 [ 89,407]    not measured      not measured
//   Crane   > Boulder   not measured      not measured      not measured
//
// Every interval that exists clears zero, so each of those rungs is really
// stronger than the one below it. Two things the table says that the ratings
// do not:
//
//   The ladder is not evenly spaced, and it is differently uneven per mode.
//   The retired mode's rungs converged as they climbed while Infiltration's
//   start much closer together. One rating per rung is a deliberate product
//   simplification, not a measurement.
//
//   The gaps are wide enough that they were never in doubt; what the intervals
//   rule out is a rung being accidentally equal to its neighbour.
//
// The blank cells are blank on purpose. They were previously filled from a run
// with `--adjudicate` on, which ended 23 of 24 Boulder-Snips games in the
// retired mode by resignation and 9 of 10 for Crane-Boulder — so those numbers
// described the adjudication threshold, not the bots, and playing them out
// moved Boulder-Snips from +172 to +232. Since no bot resigns against a
// person, only played-out games belong here. Fill them in with:
//
//   npm run arena -- --a boulder --b snips --pairs 12
//   npm run arena -- --a crane --b boulder --pairs 12
//   npm run arena -- --a obsidian --b crane --pairs 6
//
// The last of those is the expensive one: at four seconds a move it takes
// hours per mode, which is why Obsidian's separation has never been measured.
//
// Ratings are display labels for the lobby, ordered to match the measured
// results rather than pinned to any external scale. They are the one thing
// here with no effect on play, so a rung can be relabelled on its own.

// Shared limits that are not per-difficulty.
export const BOT_TUNING = Object.freeze({
  // One shared ceiling for every search a bot or a hint runs. This is a safety
  // valve against a pathological position, not a strength dial: keep it well
  // above what the deepest profile actually spends (the top rung uses about
  // 11 million nodes in four seconds) so the depth and timeout stay in charge.
  maxNodes: 60_000_000,
  // The hint button is the player's tool, not the bot's, so it always gets a
  // strong search regardless of which bot is on the other side — and it should
  // out-see the strongest bot, because its job is to teach.
  hint: Object.freeze({
    maxDepth: 14,
    maxTimeMs: 2_500,
  }),
  // The widest candidate set a profile can ask for, and the engine's own cap
  // (`MAX_VARIATIONS` in `RPSFish/src/wasm.rs`). Eight rather than three
  // because three near-equivalent moves is not enough material to be weak
  // with: going from three lines to eight roughly triples the score range a
  // profile has to sample within, which is what lets a low rung play a
  // plausible bad move instead of a uniformly random legal one.
  maxCandidateLines: 8,
  // Between-iteration yield inside the worker. Zero keeps a bot's short search
  // from paying a scheduling tax it does not need.
  throttleMs: 0,
  // Safety valve for unattended bot-vs-bot games.
  maxMovesPerArenaGame: 400,
  // Random opening length for arena measurement. Long enough that the two
  // games of a pair are not the same game, short enough to stay a position a
  // real game could reach.
  arenaOpeningPlies: 6,
});

// Ordered weakest to strongest; the lobby renders them in this order.
//
// Below the top rung the timeout is a backstop only — those depths cost
// milliseconds, so `maxDepth` and `choice` are what define the bot and a slow
// or busy device cannot quietly make it weaker.
export const BOT_PROFILES: readonly BotProfile[] = Object.freeze([
  Object.freeze({
    id: 'pebble',
    name: 'Pebble',
    rating: 500,
    blurb: 'Barely looks at the board. Will hand you pieces.',
    search: Object.freeze({ maxDepth: 2, maxTimeMs: 1_000 }),
    choice: Object.freeze({
      candidateLines: 8,
      // Chance of ignoring the search entirely and playing any legal move.
      // Lower than it was: with eight candidates to sample from, most of the
      // weakness now comes from moves the engine actually considered, which
      // look like a beginner's moves rather than like a glitch.
      randomMoveChance: 0.22,
      // Softmax spread over candidate scores, in multiples of this mode's
      // choice unit. At 3 units even the eighth-best move keeps about half the
      // weight of the best, so this rung is close to uniform over what it
      // sees — deliberately, since it is the beginner rung. 0 = always best.
      temperatureUnits: 3,
      // Hard guardrail: a candidate this much worse than the best is dropped
      // before the softmax runs. Infinity = no guardrail.
      maxLossUnits: Infinity,
    }),
    tempo: Object.freeze({ minThinkMs: 200, maxThinkMs: 550 }),
    manners: Object.freeze({
      // Arena adjudication only; no bot resigns against a person.
      resignBelowArmies: null,
      resignAfterMove: 0,
      // Accepts a draw when the position is within this of level, as a share
      // of a starting army. Unlike resignation this does apply against a
      // person: a draw is offered by the player, so answering it is not the
      // bot taking their win away.
      acceptDrawWithinArmies: 0.6,
      acceptDrawAfterMove: 0,
    }),
  }),
  Object.freeze({
    id: 'napkin',
    name: 'Napkin',
    rating: 800,
    blurb: 'Sees a move or two ahead, then hopes.',
    search: Object.freeze({ maxDepth: 3, maxTimeMs: 1_000 }),
    choice: Object.freeze({
      candidateLines: 8,
      randomMoveChance: 0.1,
      temperatureUnits: 1.6,
      maxLossUnits: 4,
    }),
    tempo: Object.freeze({ minThinkMs: 250, maxThinkMs: 700 }),
    manners: Object.freeze({
      resignBelowArmies: null,
      resignAfterMove: 0,
      acceptDrawWithinArmies: 0.35,
      acceptDrawAfterMove: 0,
    }),
  }),
  Object.freeze({
    id: 'snips',
    name: 'Snips',
    rating: 1_100,
    blurb: 'Punishes anything you leave hanging.',
    search: Object.freeze({ maxDepth: 4, maxTimeMs: 1_500 }),
    choice: Object.freeze({
      candidateLines: 6,
      randomMoveChance: 0.04,
      temperatureUnits: 0.9,
      maxLossUnits: 3,
    }),
    tempo: Object.freeze({ minThinkMs: 300, maxThinkMs: 900 }),
    manners: Object.freeze({
      resignBelowArmies: -0.75,
      resignAfterMove: 24,
      acceptDrawWithinArmies: 0.2,
      acceptDrawAfterMove: 12,
    }),
  }),
  Object.freeze({
    id: 'boulder',
    name: 'Boulder',
    rating: 1_400,
    blurb: 'Solid, patient, and hard to shift once it is set.',
    search: Object.freeze({ maxDepth: 7, maxTimeMs: 2_000 }),
    choice: Object.freeze({
      candidateLines: 5,
      randomMoveChance: 0.015,
      temperatureUnits: 0.5,
      maxLossUnits: 2,
    }),
    tempo: Object.freeze({ minThinkMs: 400, maxThinkMs: 1_200 }),
    manners: Object.freeze({
      resignBelowArmies: -0.65,
      resignAfterMove: 20,
      acceptDrawWithinArmies: 0.12,
      acceptDrawAfterMove: 12,
    }),
  }),
  Object.freeze({
    id: 'crane',
    name: 'Crane',
    rating: 1_700,
    blurb: 'Folds your plans neatly into its own.',
    search: Object.freeze({ maxDepth: 11, maxTimeMs: 3_000 }),
    choice: Object.freeze({
      candidateLines: 3,
      randomMoveChance: 0.004,
      temperatureUnits: 0.25,
      maxLossUnits: 1.2,
    }),
    tempo: Object.freeze({ minThinkMs: 450, maxThinkMs: 1_500 }),
    manners: Object.freeze({
      resignBelowArmies: -0.6,
      resignAfterMove: 16,
      acceptDrawWithinArmies: 0.07,
      acceptDrawAfterMove: 10,
    }),
  }),
  Object.freeze({
    id: 'obsidian',
    name: 'Obsidian',
    rating: 1_900,
    blurb: 'RPSFish at full concentration. No gifts.',
    // Depth is the target and the timeout is the real governor: Infiltration
    // reaches the full 16 in about a second, while Total War runs out of time
    // around depth 13–15. Lower the timeout first if four seconds feels long.
    // Measured against the WebAssembly build rather than guessed: on the
    // reference machine Infiltration reaches depth 17 in 1.5s, 18 in 2.2s, 19
    // in 3.0s, and 20 in 8.7s. Nineteen is the deepest rung that still fits
    // inside the timeout, which keeps the timeout a backstop and the bot's
    // strength reproducible instead of a function of how busy the device is.
    // The old cap of 16 finished Infiltration in about a second and then
    // returned, spending a quarter of the budget it had already asked for.
    // Total War is time-limited at depth 13 either way, so this changes only
    // Infiltration.
    search: Object.freeze({ maxDepth: 19, maxTimeMs: 4_000 }),
    choice: Object.freeze({
      candidateLines: 1,
      randomMoveChance: 0,
      temperatureUnits: 0,
      maxLossUnits: 0,
    }),
    tempo: Object.freeze({ minThinkMs: 500, maxThinkMs: 1_800 }),
    manners: Object.freeze({
      resignBelowArmies: -0.55,
      resignAfterMove: 14,
      acceptDrawWithinArmies: 0.04,
      acceptDrawAfterMove: 8,
    }),
  }),
] as const satisfies readonly BotProfile[]);

export const DEFAULT_BOT_PROFILE_ID = 'snips';

const FIRST_PROFILE = BOT_PROFILES[0];
if (!FIRST_PROFILE) throw new Error('The bot ladder is empty.');

export const botProfile = (profileId: string | undefined): BotProfile =>
  BOT_PROFILES.find((profile) => profile.id === profileId) ??
  BOT_PROFILES.find((profile) => profile.id === DEFAULT_BOT_PROFILE_ID) ??
  FIRST_PROFILE;
