// The ranked round, as something to watch.
//
// The pool is the only thing that moves an engine's rating, and until it was
// published it was invisible: it seated its games on the hour, they appeared in
// the rail looking exactly like two people pitting bots against each other for
// fun, and nothing anywhere said a round was coming or had just run. A schedule
// nobody can see is indistinguishable from a random one — which is the argument
// the server already makes for publishing it, and this is the other half of it.
//
// Pure functions over the published schedule, in the same spirit as
// `liveSelectors.ts`, so the rail's countdown and the hourly-rounds page cannot
// grow two ideas of which round is next.
//
// # What is not here
//
// Who is in the next round. This file used to derive that from the socket's bot
// roster, mirroring `ladderBotIsAvailable` on the server, on the argument that
// the client is already told the answer once a second. It is not: the roster
// only has engines that are *connected*, and "mine is entered and is not in the
// round" is answered by "it is not running" more often than by anything else —
// which is exactly the case a list built from the roster cannot contain. So the
// field is served, with the server's own reason beside each engine, and the
// rounds page reads it from `/api/ladder-rounds`.

import { timeControlLabel } from '@/store/setupSelectors';
import type { LadderRoundPreview } from '@/store/api/ladderPool';
import type { ModeDefinition } from '@/types/game';

/**
 * How long after a round is seated it is still worth calling it under way.
 *
 * A round is one pairing per engine and a pairing is two games, so its length is
 * two games on the round's clock — a couple of minutes at 1+1 and the better
 * part of half an hour at 5+2. This is the generous end of that rather than an
 * average, because the cost of the two mistakes is not symmetric: saying a round
 * is on when it has finished sends somebody to the live boards, which are right
 * there and interesting anyway, while saying it is over when it is still running
 * hides the one thing this block exists to point at.
 */
export const LADDER_ROUND_LIVE_MS = 20 * 60_000;

/** How close a round has to be before it is worth leaning on. */
export const LADDER_ROUND_SOON_MS = 10 * 60_000;

/** Where the pool is in its hour. */
export type LadderRoundPhase = 'live' | 'soon' | 'waiting';

/**
 * The part of the published pool a countdown is built from.
 *
 * Narrower than either payload that satisfies it, deliberately: `/api/ladder-pool`
 * and `/api/ladder-rounds` both carry these three fields and a good deal else,
 * and naming only what is read is what lets the rail and the rounds page share
 * one answer without the page having to fetch the rail's payload as well.
 */
export interface LadderSchedule {
  schedule: LadderRoundPreview[];
  lastRoundAtUnixMs: number;
  anchorBotId: string;
  /**
   * How late a slot may still be seated, from the server.
   *
   * Absent from a backend older than this build, and treated as zero there —
   * which is the behaviour this file had before the field existed.
   */
  graceMs?: number;
}

/** The next round, as a page or a rail draws it. */
export interface LadderRoundView {
  /** The round being counted down to, absent when the server served no schedule. */
  next: LadderRoundPreview | null;
  phase: LadderRoundPhase;
  /** Milliseconds until it starts, floored at zero. */
  inMs: number;
  /** That, written for a reader: `12:04`. */
  countdown: string;
  /** The round's mode, resolved once so the caller does not look it up. */
  mode: ModeDefinition | null;
  /** Its clock, already labelled — `3+1`. */
  clock: string;
  /** The server's own count of the engines it would seat, for this round only. */
  entered: number;
  /**
   * No reference engine is designated, so the board is measured from its own
   * weakest engine rather than from chance.
   *
   * Ratings are published either way — what changes is what 1 means. Said out
   * loud rather than left to be inferred, because "1 is the weakest engine here"
   * and "1 is no better than chance" print identically and are not the same
   * claim, and the second is what the rest of the app's copy promises.
   */
  relativeScale: boolean;
}

/**
 * A duration as a countdown clock.
 *
 * Minutes and seconds, and an hour field only when there is one to show — the
 * rounds are an hour apart, so `1:00:00` appears for a moment at the top of each
 * one and never otherwise, and padding every countdown to carry that case would
 * cost two characters on a 296-point rail for the rest of the hour.
 */
export const countdownLabel = (ms: number): string => {
  const total = Math.max(0, Math.round(ms / 1000));
  const seconds = total % 60;
  const minutes = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3600);
  const pad = (value: number) => String(value).padStart(2, '0');
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
};

/**
 * Everything a countdown needs, from the facts.
 *
 * `now` is passed in rather than read, so this is testable and so a whole page
 * ticks off one clock instead of each part of it keeping its own.
 */
export const ladderRoundView = (
  pool: LadderSchedule | null,
  modes: ModeDefinition[],
  now: number,
): LadderRoundView | null => {
  if (!pool) return null;
  // The round the server itself calls next, which is not simply the first one in
  // the future.
  //
  // A slot may be seated a few minutes late, so for that long after the hour the
  // head of the schedule is a moment *just past* and is still the round about to
  // run — see `nextLadderRound` on the server, which is where the head comes
  // from. Skipping it on the strength of the clock alone would count down to the
  // hour after, which on the rounds page is worse than a wrong clock: the field
  // beside it is computed for the round the server picked, so the two would be
  // describing different hours, and an engine that plays one mode and not the
  // other would be listed under the wrong heading.
  //
  // Past the grace the head has been skipped or has already run, and then the
  // next one really is the answer — which is also the case a stale payload in a
  // long-open tab is in.
  const grace = pool.graceMs ?? 0;
  const next = pool.schedule.find((round) => round.atUnixMs > now - grace) ?? null;
  if (!next) return null;

  const inMs = Math.max(0, next.atUnixMs - now);
  const sinceLast = pool.lastRoundAtUnixMs > 0 ? now - pool.lastRoundAtUnixMs : Infinity;
  const phase: LadderRoundPhase =
    // At zero the round is being seated, whether or not the last one is recent:
    // a clock reading 0:00 next to "starts in" has to be explained by the badge
    // beside it rather than left looking stopped.
    inMs === 0 || (sinceLast >= 0 && sinceLast < LADDER_ROUND_LIVE_MS)
      ? 'live'
      : inMs <= LADDER_ROUND_SOON_MS
        ? 'soon'
        : 'waiting';

  return {
    next,
    phase,
    inMs,
    countdown: countdownLabel(inMs),
    mode: modes.find((mode) => mode.id === next.modeId) ?? null,
    clock: timeControlLabel({
      initialTimeMs: next.initialTimeMs,
      incrementMs: next.incrementMs,
    }),
    entered: next.entered,
    relativeScale: !pool.anchorBotId,
  };
};

/** The round's conditions in one line: `Intransitive · 3+1`. */
export const ladderConditionsLine = (round: LadderRoundView): string =>
  `${round.mode?.name ?? round.next?.modeId ?? ''} · ${round.clock}`;
