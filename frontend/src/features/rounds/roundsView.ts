// Reading the hourly round.
//
// The page's arithmetic, kept out of the screen for the reason `pitSelection`
// gives about its own: a screen with no render tests cannot afford rules that
// only show up as a wrong word on a row. Every rule here is one somebody would
// read as a fact about their own engine — "entered", "ready", "will not run" —
// and getting one of those backwards is worse than showing nothing, because it
// sends an owner to look for a fault that is not there.
//
// None of it re-decides anything the server decided. Whether a round would seat
// an engine is `ladderBotRefusal`'s answer and arrives as `ready` and `reason`;
// what is here is grouping, counting, and turning those into words.

import type {
  LadderFieldEngine,
  LadderRoundPreview,
  LadderRounds,
} from '@/store/api/ladderPool';
import type { OwnedBot } from '@/store/api/bots';
import type { ModeDefinition } from '@/types/game';
import { timeControlLabel } from '@/store/setupSelectors';
import type { BadgeTone } from '@/ui/tones';

/** The field, split into the two reasons an engine is in it. */
export interface LadderFieldGroups {
  /**
   * Engines their owners entered, and that somebody is running. The part of a
   * round that is news, and the only part anybody can change.
   */
  entered: LadderFieldEngine[];
  /**
   * The server's reference engines, which are in every round whatever their
   * owner set because the whole scale is measured from them.
   *
   * Apart from the list above rather than mixed into it, and *not* hidden. On
   * the rail they were reduced to a count, which was right for a 296-point
   * column and wrong here: "why is that engine in every round" is one of the
   * questions this page exists to answer, and it cannot be answered about
   * engines that are not on it.
   */
  references: LadderFieldEngine[];
  /**
   * How many of the whole field the round will use.
   *
   * Includes the engines that are in a game right now: the round pairs them and
   * holds the pairing until a slot frees, so they are in it — later. Counting
   * only the idle ones was the number that read as "two engines are being
   * skipped" when nothing was being skipped at all.
   */
  inRound: number;
  /** How many of those are in a game, and will therefore start late. */
  waiting: number;
  /**
   * Entered engines nobody is running, which neither list draws.
   *
   * Counted rather than listed. An engine that is here and unavailable — in a
   * game, shutting down, held for an event, not built for this mode — says
   * something about the round and earns its row. One that is not running says
   * only that its owner's machine is off, and it would say it every hour, on
   * every screen, until they happened to start it: a standing list of absent
   * names between the reader and the engines that are actually about to play.
   *
   * Not dropped silently, though. The number is still on the page, because
   * "twelve bots are entered" and "four are here" are both true and somebody
   * who knows the first should not have to wonder whether the page is broken.
   * And an owner's own offline engine is named in full one panel down, where
   * the question is about them rather than about the round.
   */
  away: number;
}

export const ladderFieldGroups = (field: LadderFieldEngine[]): LadderFieldGroups => {
  const here = field.filter((engine) => engine.online);
  return {
    entered: here.filter((engine) => !engine.reference),
    references: here.filter((engine) => engine.reference),
    // Over the whole field rather than over `here`, which costs nothing —
    // an engine nobody is running is never in the round — and keeps this the
    // answer to "how many will play" rather than to "how many of the rows
    // below".
    inRound: field.filter((engine) => engine.ready).length,
    waiting: field.filter((engine) => engine.ready && engine.waiting).length,
    away: field.length - here.length,
  };
};

/**
 * "7 of 8 ready" — the field's own summary.
 *
 * Both numbers, which is the whole fix for the count the rail used to carry.
 * "7 engines entered" was one number doing two jobs: it was read as the size of
 * the field and it meant the number the round would seat, so an owner whose
 * engine was entered and asleep was inside one of those and outside the other
 * with no way to tell.
 *
 * The denominator is the engines on screen, so the summary counts the rows
 * under it. The ones that are away are in `awayNote` instead — a number that
 * did not match the list it sits above would be the same trap in a new place.
 */
export const fieldSummary = (groups: LadderFieldGroups): string =>
  `${groups.inRound} of ${groups.entered.length + groups.references.length} in`;

/**
 * The engines whose games start late, in a sentence, or nothing.
 *
 * The whole of what the wording got wrong before. A busy engine was counted out
 * and tagged in the same grey as a refusal, so a field of five with two playing
 * read as "three are in and two are not" — when all five are in and two start a
 * few minutes later. Said in words rather than left to the tags, because it is
 * the part somebody is checking when their own engine is one of the two.
 */
export const waitingNote = (groups: LadderFieldGroups): string | null =>
  groups.waiting === 0
    ? null
    : `${groups.waiting} ${groups.waiting === 1 ? 'engine is' : 'engines are'} busy. Paired games start when a slot opens, not next hour.`;

/** The entered engines nobody is running, in a sentence, or nothing. */
export const awayNote = (groups: LadderFieldGroups): string | null =>
  groups.away === 0
    ? null
    : `${groups.away} more ${groups.away === 1 ? 'engine is' : 'engines are'} entered but offline.`;

/**
 * How one engine's standing in the next round reads, and in what colour.
 *
 * The reason comes from the server verbatim. Rewriting it here would be a
 * second set of words for the same five states, and the one that went stale
 * would be this one — the server's are next to the rules that produce them.
 */
export const fieldStatus = (
  engine: LadderFieldEngine,
): { label: string; tone: BadgeTone } => {
  if (!engine.ready) {
    return { label: (engine.reason ?? 'not available').toUpperCase(), tone: 'neutral' };
  }
  // In either way, so both read as in — the tone is the difference, not the
  // presence of a tag. "EVERY SLOT IS PLAYING" used to sit here in the same
  // grey a refusal wears, which is how an engine the round was going to use
  // came to look like one it was leaving out.
  return engine.waiting
    ? { label: 'IN WHEN FREE', tone: 'cool' }
    : { label: 'IN', tone: 'accent' };
};

/**
 * Whether the next round will actually seat anything, and what to say if not.
 *
 * Null when it will. A round needs two available engines and finds them most of
 * the time, but a quiet morning with one engine online is a round that passes
 * with no games in it — and that looks exactly like the pool being broken
 * unless somebody says otherwise before the hour rather than after it.
 */
export const shortFieldNote = (view: {
  inRound: number;
  minimumField: number;
}): string | null => {
  if (view.inRound >= view.minimumField) return null;
  if (view.inRound === 0) {
    return `No engines entered. At least ${view.minimumField} are needed to play.`;
  }
  return `${view.inRound} entered; at least ${view.minimumField} needed to play.`;
};

/** One of your own engines, as this page has to talk about it. */
export interface OwnedEntry {
  bot: OwnedBot;
  /** The owner's switch: whether the pool is allowed to pair it at all. */
  entered: boolean;
  /**
   * Its row in the published field, when it has one.
   *
   * Absent for an engine that is not entered — the field only contains engines
   * that are — and that is the distinction the page turns on: "not entered" is
   * a choice, and every other answer is a circumstance.
   */
  field: LadderFieldEngine | null;
}

/**
 * Your engines, joined to the field, in the order the page lists them.
 *
 * Retired slots are dropped: a retired bot cannot be entered, and offering its
 * switch would be offering a control that does nothing. Nothing else is
 * filtered — an unclaimed slot and an offline engine both belong here, because
 * "why is mine not in the round" is answered by their own state.
 */
/**
 * "1 of 2 entered", over the engines the question applies to.
 *
 * Unclaimed slots are outside both numbers. Their switch reads as on because
 * that is the column default, and the client overwrites it on the first connect
 * anyway — so counting one as entered would be claiming something about an
 * engine that does not exist yet, in the heading of the panel whose rows
 * deliberately say nothing about it.
 */
export const enteredSummary = (entries: OwnedEntry[]): string | null => {
  const claimed = entries.filter((entry) => entry.bot.claimed);
  if (claimed.length === 0) return null;
  return `${claimed.filter((entry) => entry.entered).length} of ${claimed.length} entered`;
};

/**
 * Whether this engine could play a ranked match this second.
 *
 * Asked so the button can be disabled rather than pressed into an error: every
 * state this returns false for is one `ownedStatus` already explains in the
 * line beside it, and a button that fails with the sentence that was on screen
 * before the press is a worse way to say the same thing.
 *
 * `waiting` is a no here while the round treats it as a yes, which is the one
 * clause worth reading twice. A round can pair an engine that is mid-game and
 * hold the pairing until it frees, because a round has an hour; a press has a
 * person waiting on it, so the server refuses the same state. Disagreeing with
 * the field on purpose is safe only because both sides say so — see
 * pickLadderOpponent.
 */
/**
 * Whether this engine could start a ranked match this second.
 *
 * Says no to a `waiting` engine while the field says it is in the round, and
 * that disagreement is deliberate: a round pairs a busy engine and holds the
 * pairing until a slot frees, and a press has nobody to hold it for. The server
 * refuses the same state — see `pickLadderOpponent`.
 */
export const canPlayRankedNow = (entry: OwnedEntry): boolean =>
  entry.bot.claimed && entry.entered && (entry.field?.ready ?? false) && !entry.field?.waiting;

export const ownedEntries = (
  bots: OwnedBot[],
  field: LadderFieldEngine[],
): OwnedEntry[] =>
  bots
    .filter((bot) => !bot.retired)
    .map((bot) => ({
      bot,
      entered: bot.enterLadder,
      field: field.find((engine) => engine.botId === bot.botId) ?? null,
    }));

/**
 * What one of your own engines is doing about the next round, in a sentence.
 *
 * Four states, and the order they are asked in is the whole of the design. An
 * engine nobody has ever run cannot usefully be told anything about rounds, so
 * that is answered first; then the switch, which is the only part the owner
 * controls from here; then the server's own reason; then the good case.
 */
export const ownedStatus = (entry: OwnedEntry): string => {
  if (!entry.bot.claimed) {
    // And it says nothing about the switch on purpose. The client sends its own
    // `ladder` setting when it claims a slot, so whatever this page set before
    // the first connection is overwritten by rpsbot.conf — the panel draws no
    // button for one of these, and a status line mentioning a state that is
    // about to be replaced would be the same lie in words.
    return "Run the client with this token to connect your bot.";
  }
  if (!entry.entered) {
    return "Not entered in ranked rounds.";
  }
  if (entry.field?.waiting) {
    return "Entered. Joins when its current game ends.";
  }
  if (entry.field?.ready) return 'Entered and ready for the next round.';
  if (entry.field?.reason) return `Entered, but ${entry.field.reason}.`;
  // Entered with no row in the field at all. That is a disabled bot, or a
  // database the field was read from before this switch reached it; either way
  // the honest answer is that the round will not have it, without inventing a
  // reason the server did not give.
  return "Entered, but unavailable for the next round.";
};

/** One row of the published schedule, ready to draw. */
export interface ScheduleRow {
  key: string;
  atUnixMs: number;
  /** `15:00` in the reader's own zone, because that is the clock they keep. */
  at: string;
  mode: string;
  clock: string;
  /** The round being counted down to, which is the one the field is about. */
  next: boolean;
}

/**
 * The rotation as rows.
 *
 * Local times, not the host's and not UTC. The rounds are on the hour in UTC,
 * so for a reader on a half-hour offset they land at half past — and a page
 * that printed the hour would be telling them the wrong minute, which is the
 * one thing a countdown page cannot afford. `dayAndTime` on the weekend page
 * makes the same argument at greater length.
 *
 * Rounds already past are dropped rather than greyed: the head of the served
 * schedule is the round still owed, so for a few minutes after each hour it is
 * a moment in the past, and a row saying a round is at a time that has been is
 * indistinguishable from the schedule having slipped.
 */
export const scheduleRows = (
  schedule: LadderRoundPreview[],
  modes: ModeDefinition[],
  now: number,
): ScheduleRow[] => {
  const upcoming = schedule.filter((round) => round.atUnixMs > now);
  return upcoming.map((round, index) => ({
    key: String(round.atUnixMs),
    atUnixMs: round.atUnixMs,
    at: new Date(round.atUnixMs).toLocaleTimeString(undefined, {
      hour: '2-digit',
      minute: '2-digit',
    }),
    mode: modes.find((mode) => mode.id === round.modeId)?.name ?? round.modeId,
    clock: timeControlLabel({
      initialTimeMs: round.initialTimeMs,
      incrementMs: round.incrementMs,
    }),
    next: index === 0,
  }));
};

/**
 * How the last round went, in one line.
 *
 * A round is a set of two-game runs rather than one result, so the summary is a
 * count of them and of the games underneath. A round that seated nothing says
 * so in words: an empty scoreboard under a heading with a time on it reads as a
 * page that failed to load.
 */
export const lastRoundSummary = (view: LadderRounds): string => {
  const series = view.last?.series ?? [];
  if (!view.last) return 'The pool has not run a round yet.';
  if (series.length === 0) {
    return "No games played. No engines were available.";
  }
  const games = series.reduce(
    (total, run) => total + (run.games ?? []).filter((game) => game.result !== 'pending').length,
    0,
  );
  const pairings = `${series.length} pairing${series.length === 1 ? '' : 's'}`;
  return `${pairings} · ${games} game${games === 1 ? '' : 's'} played`;
};
