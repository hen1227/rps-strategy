import { timeControlLabel } from '@/store/setupSelectors';
import type { ModeDefinition, TimeControl } from '@/types/game';
import type { BotPresence } from '@/types/protocol';

// Choosing the two engines, and describing the fight they make.
//
// This is the logic the Bots page used to carry inline, and it moved out for
// one reason: the picks are made on the cards and the run is started from a
// pinned bar at the foot of the page, so two components now depend on the same
// four rules. A screen with no render tests cannot afford them to be two
// copies — and the page's own comments say so, since the interesting rule here
// (what a third press does when both sides are taken) is exactly the kind
// nobody would notice breaking.

/** The two sides of the series form, as the page holds them. */
export interface PitPick {
  first: string | null;
  second: string | null;
}

/** Nothing entered. */
export const NO_PIT_PICK: PitPick = { first: null, second: null };

/**
 * A press on an engine's card.
 *
 * Fills the first empty side, or empties the side this engine is already in.
 * With both sides taken it keeps the two most recent presses, which is the
 * only rule that lets somebody walk down the roster comparing engines without
 * having to empty a slot between each pair.
 */
export const nextPitPick = (pick: PitPick, botId: string): PitPick => {
  if (pick.first === botId) return { first: null, second: pick.second };
  if (pick.second === botId) return { first: pick.first, second: null };
  if (!pick.first) return { first: botId, second: pick.second };
  if (!pick.second) return { first: pick.first, second: botId };
  return { first: pick.second, second: botId };
};

export const clearedPitPick = (pick: PitPick, side: 'first' | 'second'): PitPick =>
  side === 'first' ? { first: null, second: pick.second } : { first: pick.first, second: null };

export const swappedPitPick = (pick: PitPick): PitPick => ({
  first: pick.second,
  second: pick.first,
});

/**
 * Whether both engines belong to one person, which is what makes a run casual
 * — the ladder does not rate a pair of bots one person registered. The server
 * settles it in `sameBotOwner`; this is the form saying so in advance.
 *
 * The empty check is the whole of the care needed: `ownerUserId` is absent for
 * an engine whose owner the roster does not carry, and two absent owners
 * compared as strings would read as one person owning both.
 */
export const sameBotOwner = (
  first: BotPresence | null,
  second: BotPresence | null,
): boolean => Boolean(first?.ownerUserId) && first?.ownerUserId === second?.ownerUserId;

/**
 * Whether there is a run to start. The mode is in here because the page can
 * resolve none at all, and a hook cannot be conditional on that.
 */
export const canStartSeries = ({
  busy,
  first,
  mode,
  second,
}: {
  busy: boolean;
  first: BotPresence | null;
  mode: ModeDefinition | null;
  second: BotPresence | null;
}): boolean =>
  !busy && Boolean(mode) && Boolean(first) && Boolean(second) && first !== second;

/**
 * The run in one line: what it is played at, how long it is, on what clock.
 *
 * Shared by the panel's summary and the pinned bar, so the two cannot describe
 * the same run differently. `pairs` is the raw field text rather than a number
 * because that is what the form holds and what the request will clamp.
 */
export const seriesSettingsLine = ({
  casual,
  clock,
  mode,
  pairs,
}: {
  casual?: boolean;
  clock: TimeControl;
  mode: ModeDefinition;
  pairs: string;
}): string =>
  `${mode.name} · ${pairs} pairs, colours swapped · ${timeControlLabel(clock)}${
    casual ? ' · casual' : ''
  }`;

export interface PitBarView {
  /** Whether the bar belongs on screen at all. */
  visible: boolean;
  /** Which side is still empty, and therefore draws a `?`. */
  empty: 'first' | 'second' | null;
  /** What to do about the empty side, or absent once both are filled. */
  hint: string | null;
  /** The run, for the line under the portraits. Shown when `hint` is absent. */
  settings: string;
  /** The button. */
  label: string;
  /** The button, for a screen reader. */
  action: string;
}

/**
 * Everything the pinned bar draws, from the facts.
 *
 * Deliberately not given `canStart`: whether the button is live is one
 * question with one owner (the form hook), and a second copy of it here would
 * be a second thing to keep in step.
 */
export const pitBarView = ({
  available,
  clock,
  first,
  mode,
  pairs,
  second,
}: {
  /** How many engines could be entered right now. */
  available: number;
  clock: TimeControl;
  first: BotPresence | null;
  mode: ModeDefinition;
  pairs: string;
  second: BotPresence | null;
}): PitBarView => {
  const casual = sameBotOwner(first, second);
  const settings = seriesSettingsLine({ casual, clock, mode, pairs });
  const label = casual ? 'START CASUAL SERIES ▶' : 'START SERIES ▶';

  if (first && second) {
    return {
      visible: true,
      empty: null,
      hint: null,
      settings,
      label,
      action: `Start a ${pairs}-pair ${casual ? 'casual ' : ''}${mode.name} series: ${
        first.name
      } against ${second.name}`,
    };
  }

  const empty = first ? 'second' : second ? 'first' : null;
  if (!empty) return { visible: false, empty: null, hint: null, settings, label, action: label };

  // Which side is empty is not cosmetic: the first engine opens game one of
  // every pair, so the `?` stays on its own side rather than always on the
  // right. And with nothing left to press, "pick a second engine" would be an
  // instruction that cannot be followed — an engine that was free when the
  // other was chosen can pick up a game a moment later.
  const waiting =
    available < 2
      ? { hint: 'NO OTHER ENGINE IS FREE', action: 'No other engine is free for a series' }
      : empty === 'second'
        ? { hint: 'PICK A SECOND ENGINE', action: 'Pick a second engine to start a series' }
        : { hint: 'PICK A FIRST ENGINE', action: 'Pick a first engine to start a series' };

  return { visible: true, empty, hint: waiting.hint, settings, label, action: waiting.action };
};
