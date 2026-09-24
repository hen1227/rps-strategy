// The ranked pool's schedule.
//
// One read for the whole thing, the same shape the weekend page takes: the
// server publishes what the pool is about to do and what it has just done, and
// a countdown that arrives a beat after the round it counts down to would be
// worse than none.
//
// Worth knowing why this endpoint exists at all, because it decides what the
// client is allowed to assume: the pool picks the mode and the clock from a
// rotation derived purely from the hour, so the schedule is not a plan that
// could change — it is a fact that can be computed in advance, and is published
// so that "the conditions are not yours to choose" can be checked rather than
// taken on trust. See backend/internal/server/ladder_pool.go.

import type { BotSeries } from "./bots";
import { apiClient } from "./http";
import type { ModeID } from "@/types/game";
import type { RatingState } from "@/types/protocol";

const request = apiClient("ladder pool");

/** One round the pool will run, or is running. */
export interface LadderRoundPreview {
  modeId: ModeID;
  initialTimeMs: number;
  incrementMs: number;
  atUnixMs: number;
  /**
   * Engines online, consenting and able to play this round's mode.
   *
   * Only the first entry carries one — a field size is a fact about now, and
   * claiming to know next Tuesday's would be a guess dressed as a schedule. The
   * rail draws its own lineup from the roster instead, which moves as engines
   * connect; this stays as the server's own count to check that against.
   */
  entered: number;
}

/** What the pool is doing, and the scale it publishes on. */
export interface LadderPool {
  /** Rounds seated since the server started counting. */
  roundsRun: number;
  lastRoundAtUnixMs: number;
  intervalMs: number;
  /**
   * How late a slot may still be seated.
   *
   * What it is for is deciding whether the head of the schedule below is a round
   * still owed or one that has already run — the two are told apart by nothing
   * else, and a reader that assumed the second would count down to the wrong
   * hour for the few minutes an hour the first is true. See `ladderRoundView`.
   */
  graceMs: number;
  /** Games one engine plays in a round: one pairing, both colours. */
  gamesPerRound: number;
  /**
   * This round and the next few, soonest first.
   *
   * The head is the round the server still owes, so for a few minutes after the
   * hour it is a moment just past rather than one to come — count down to the
   * first entry later than now, the way `ladderRoundView` does.
   */
  schedule: LadderRoundPreview[];
  /**
   * The engine the whole scale is measured from, empty when none is designated.
   *
   * Empty is a real and visible state rather than an error: until a yardstick
   * exists the fit publishes nothing and every rating reads at the floor, so a
   * client that draws rating movement has to be able to tell "nothing moved"
   * from "there is no board yet".
   */
  anchorBotId: string;
  /**
   * Every reference engine, the anchor included.
   *
   * May contain empty strings — the server builds this by putting the anchor in
   * front of the rungs, and an undesignated anchor is an empty id rather than an
   * absent one. Filter before using it as a set.
   */
  yardstickBotIds: string[];
  ratingFloor: number;
  ratingPointsPerDoubling: number;
}

export const fetchLadderPool = (): Promise<LadderPool> =>
  request<LadderPool>("/api/ladder-pool", { what: "the ladder pool" });

/**
 * One engine in the field for the next round.
 *
 * Every engine whose owner has entered it, connected or not — which is the
 * difference between this and the `entered` count above, and the whole reason
 * the route exists. A count cannot say "yours is not in it because it is not
 * running", and that is the answer three quarters of the time.
 */
export interface LadderFieldEngine {
  botId: string;
  userId: string;
  name: string;
  iconSha256?: string;
  /** Whoever registered it. Absent for a reference engine and for a deleted owner. */
  author?: string;
  /**
   * A yardstick: in every round whatever anybody set, because the scale is
   * measured from it. Its owner's switch does not apply, so a page has to be
   * able to say which of the two reasons an engine is in the field.
   */
  reference: boolean;
  rating: number;
  ratingState: RatingState;
  /**
   * Whether anybody is running this engine at all.
   *
   * Apart from `ready`, and read instead of matching on `reason`: the words are
   * for a person and may change, and this is what the page filters on. An
   * engine that is here and merely unavailable earns a row; one that is not
   * running is counted instead. See `ladderFieldGroups`.
   */
  online: boolean;
  /** Whether the round will use it at all. */
  ready: boolean;
  /**
   * In a game right now, so its round games start when that one finishes
   * rather than at the top of the hour.
   *
   * `ready` is true for these: the round pairs a busy engine like any other and
   * holds the pairing until a slot frees. It used to skip them, which cost an
   * author the hour for having happened to be playing at five to.
   */
  waiting: boolean;
  /** Why the round will not use it, in the server's own words. Empty when it will. */
  reason?: string;
}

/** One round that has run, and what came of it. */
export interface LadderRoundReport {
  atUnixMs: number;
  modeId: ModeID;
  initialTimeMs: number;
  incrementMs: number;
  /**
   * The runs it seated, newest first. Empty for a round that found nobody
   * online, which is a real outcome and not the same as no round having run.
   */
  series: BotSeries[];
}

/** The hourly-rounds page, in one read. */
export interface LadderRounds {
  intervalMs: number;
  /** See `LadderPool.graceMs`, which means the same thing. */
  graceMs: number;
  /**
   * How long the schedule takes to repeat.
   *
   * Served rather than written down here, because it is derived from two lists
   * that live in the server — a page that hard-coded it would go on claiming
   * the old number after either list changed, above a schedule visibly saying
   * otherwise.
   */
  rotationHours: number;
  gamesPerRound: number;
  roundsRun: number;
  /** How many engines have to be available before a round seats anything. */
  minimumField: number;
  lastRoundAtUnixMs: number;
  schedule: LadderRoundPreview[];
  /** For the head of the schedule: availability is a question about one mode. */
  field: LadderFieldEngine[];
  /** Absent before the pool has ever run a round. */
  last?: LadderRoundReport | null;
  anchorBotId: string;
  ratingFloor: number;
  ratingPointsPerDoubling: number;
}

/**
 * Fill in everything the reply did not send.
 *
 * The same guard `loadWeekend` carries, for the same two reasons: Go marshals an
 * empty slice as `null`, and a backend older than this build sends a shape this
 * page has never heard of. Neither should be able to blank the screen — a page
 * with one section missing is worth reading, and a white one is not.
 */
const normalize = (view: LadderRounds): LadderRounds => ({
  ...view,
  schedule: view.schedule ?? [],
  field: view.field ?? [],
  last: view.last ? { ...view.last, series: view.last.series ?? [] } : null,
});

export const fetchLadderRounds = (): Promise<LadderRounds> =>
  request<LadderRounds>("/api/ladder-rounds", { what: "the hourly rounds" }).then(normalize);
