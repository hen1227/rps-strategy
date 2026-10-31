// What each haptic moment feels like, on each platform.
//
// One table, as data, because this is the file to tune with a phone in your
// hand. Everywhere else in the app names a *moment* — `commit`, `theirMove`,
// `step` — and never a strength, so making captures firmer is one line here
// rather than a hunt through every board and button.
//
// Weight follows meaning, as the sound ladder does (docs/sound-design.md): the
// tap that fires on every move is the lightest thing a finger feels, a capture
// is firmer, and the end of a game is the heaviest. A refused move is a small
// sharp knock rather than an alarm — a slip, not an offence.
//
// iOS gets Apple's three feedback generators, by expo-haptics' names for them.
// Android gets its haptic *constants*, not expo-haptics' `impactAsync` and
// friends: on Android those are `Vibrator` waveforms, which buzz rather than
// tap and ignore the phone's own Touch feedback switch. The constants are crisp
// and honour that switch, but each arrived in a different Android release, and
// asking for one the phone does not have throws. So every Android recipe is a
// chain, newest first, ending in a constant every phone this app installs on
// has.
//
// On Android it is the system, not this table, that decides what each constant
// feels like, so the constants are chosen by what Android 15 actually plays
// (read off `dumpsys vibrator_manager` on an emulator) rather than by name.
// `DRAG_START` plays a heavy click, as heavy as a capture, which would make every
// piece picked up land like a piece taken; `GESTURE_END` plays a lighter tick
// than the pick-up before it; `SEGMENT_FREQUENT_TICK` plays a texture tick some
// phones do not play at all. So: a click for picking up and placing, a tick for
// every detent, a heavy click for a capture and a loss, a double click for a
// refusal.
//
// The buzz is a separate channel with a separate switch: the phone's motor,
// for the two moments a player may not be looking — a game starting, and their
// clock running low.

/** A moment that can be felt. Every caller names one of these. */
export type HapticEvent =
  /** A finger lands on one of your pieces: a drag begins, or a tap selects. */
  | 'pickUp'
  /** A dragged piece crosses onto a square it could legally land on. */
  | 'hover'
  /** Your move is placed, by a drop or by a tap. */
  | 'commit'
  /** Your move is placed onto an enemy piece. */
  | 'captureCommit'
  /** A move the board or the server will not take. */
  | 'refused'
  /** The other side's move lands, in a game you are playing. */
  | 'theirMove'
  /** The other side's move takes one of your pieces. */
  | 'captured'
  | 'win'
  | 'loss'
  | 'draw'
  /** A game at a shared board ends: both sides were the hand holding it. */
  | 'ended'
  /** A lesson's answer was the right one. */
  | 'solved'
  /** A lesson's answer was not. */
  | 'wrong'
  /** Something arrived that wants an answer: an offer, a summons. */
  | 'notice'
  /** A green button. */
  | 'press'
  /** One of a handful of choices changes: a chip, a tab, a swatch. */
  | 'choose'
  | 'toggleOn'
  | 'toggleOff'
  /** One detent: a replay step, or one tick of a number counting up. */
  | 'step'
  /** A held replay arrow reaches the end of the game. */
  | 'stop'
  /** Something landed on the clipboard. */
  | 'copied';

/**
 * How long a verdict waits after the move that earned it.
 *
 * A move that wins a game against a bot, or solves a lesson, is answered in the
 * same instant it is placed, and the verdict would land inside the move's own
 * tap and be felt as one blurred knock. A beat apart, they read as the move and
 * then what it meant.
 */
export const VERDICT_DELAY_MS = 150;

/** The two moments the motor is for. */
export type BuzzMoment = 'gameStart' | 'lowClock';

/** Apple's feedback generators, by the names expo-haptics gives them. */
export type IosRecipe =
  | { kind: 'impact'; style: 'light' | 'medium' | 'heavy' | 'soft' | 'rigid' }
  | { kind: 'notification'; type: 'success' | 'warning' | 'error' }
  | { kind: 'selection' };

/** Android's `HapticFeedbackConstants`, by the names expo-haptics gives them. */
export type AndroidHaptic =
  | 'confirm'
  | 'context-click'
  | 'gesture-start'
  | 'keyboard-tap'
  | 'long-press'
  | 'reject'
  | 'segment-tick'
  | 'toggle-off'
  | 'toggle-on'
  | 'virtual-key';

/**
 * The Android release each constant arrived in.
 *
 * expo-haptics finds the constant by name at run time and throws when the
 * phone's Android has no such field, so this is the difference between a tap
 * and a rejected promise on a phone a few years old.
 */
export const ANDROID_HAPTIC_SINCE: Record<AndroidHaptic, number> = {
  'virtual-key': 5,
  'long-press': 3,
  'keyboard-tap': 8,
  'context-click': 23,
  confirm: 30,
  reject: 30,
  'gesture-start': 30,
  'segment-tick': 34,
  'toggle-off': 34,
  'toggle-on': 34,
};

/** The oldest Android this app installs on: React Native's `minSdk`. */
export const ANDROID_MIN_API = 24;

export interface HapticRecipe {
  ios: IosRecipe;
  /** Newest first. The last must exist on every Android this app installs on. */
  android: readonly AndroidHaptic[];
}

const impact = (style: 'light' | 'medium' | 'heavy' | 'soft' | 'rigid'): IosRecipe => ({
  kind: 'impact',
  style,
});
const notification = (type: 'success' | 'warning' | 'error'): IosRecipe => ({
  kind: 'notification',
  type,
});
const selection: IosRecipe = { kind: 'selection' };

export const HAPTIC_RECIPES: Record<HapticEvent, HapticRecipe> = {
  pickUp: { ios: impact('light'), android: ['gesture-start', 'virtual-key'] },
  hover: { ios: selection, android: ['segment-tick', 'context-click'] },
  commit: { ios: impact('light'), android: ['virtual-key'] },
  // A capture weighs the same whichever side made it.
  captureCommit: { ios: impact('medium'), android: ['long-press'] },
  refused: { ios: impact('rigid'), android: ['reject', 'context-click'] },
  // Soft rather than light, so the other side's move is a different touch from
  // your own even with the sound off.
  theirMove: { ios: impact('soft'), android: ['keyboard-tap'] },
  captured: { ios: impact('medium'), android: ['long-press'] },
  win: { ios: notification('success'), android: ['confirm', 'virtual-key'] },
  loss: { ios: impact('heavy'), android: ['long-press'] },
  draw: { ios: impact('medium'), android: ['virtual-key'] },
  ended: { ios: impact('medium'), android: ['virtual-key'] },
  solved: { ios: notification('success'), android: ['confirm', 'virtual-key'] },
  wrong: { ios: notification('warning'), android: ['reject', 'context-click'] },
  notice: { ios: notification('warning'), android: ['confirm', 'virtual-key'] },
  press: { ios: impact('light'), android: ['virtual-key'] },
  choose: { ios: selection, android: ['segment-tick', 'context-click'] },
  toggleOn: { ios: selection, android: ['toggle-on', 'context-click'] },
  toggleOff: { ios: selection, android: ['toggle-off', 'context-click'] },
  step: { ios: selection, android: ['segment-tick', 'context-click'] },
  // Firmer than a step, as the end of a scroll is.
  stop: { ios: impact('rigid'), android: ['virtual-key'] },
  copied: { ios: notification('success'), android: ['confirm', 'virtual-key'] },
};

/** The constant this phone's Android can play for a moment. */
export const androidHapticFor = (event: HapticEvent, apiLevel: number): AndroidHaptic => {
  const chain = HAPTIC_RECIPES[event].android;
  return (
    chain.find((constant) => ANDROID_HAPTIC_SINCE[constant] <= apiLevel) ??
    chain[chain.length - 1]!
  );
};

/**
 * The motor's pattern for each buzz, on Android: wait, buzz, wait, buzz…
 *
 * iOS plays its own fixed vibration whatever is asked for, so one buzz there
 * is the whole of it. Two firm pulses for a game starting, three short ones for
 * a clock — different enough to tell apart without looking, which is the point
 * of a buzz.
 */
export const BUZZ_PATTERNS: Record<BuzzMoment, readonly number[]> = {
  gameStart: [0, 160, 90, 160],
  lowClock: [0, 90, 70, 90, 70, 90],
};

/** What a buzz becomes for somebody who turned the motor off but kept the taps. */
export const BUZZ_FALLBACK: Record<BuzzMoment, HapticEvent> = {
  gameStart: 'win',
  lowClock: 'notice',
};

/**
 * The closest two taps may come and still be felt as two.
 *
 * Closer than this the Taptic Engine runs them together into one blurred
 * buzz, which is exactly what a count-up exists not to be.
 */
export const MIN_TICK_GAP_MS = 35;

/** The slowest a count-up ticks, so a small change is over almost at once. */
export const MAX_TICK_GAP_MS = 70;

export interface CountUpStep {
  /** When to show it, from the start of the count. */
  atMs: number;
  value: number;
}

/**
 * The steps a number takes from `from` to `to`, and when.
 *
 * One step per unit while there is time for each to be its own tap, then fewer
 * and larger ones: a rating that moves by 12 ticks twelve times, a board of 81
 * squares ticks at most `maxSteps` times and still lands exactly on 81. The
 * same steps drive the text and the taps, so what is felt is what is read.
 */
export const countUpSchedule = (
  from: number,
  to: number,
  { maxSpanMs = 600, maxSteps = 24 }: { maxSpanMs?: number; maxSteps?: number } = {},
): CountUpStep[] => {
  const start = Math.round(from);
  const end = Math.round(to);
  const distance = Math.abs(end - start);
  if (distance === 0) return [];
  const direction = Math.sign(end - start);
  const room = Math.max(1, Math.floor(maxSpanMs / MIN_TICK_GAP_MS));
  const count = Math.max(1, Math.min(distance, maxSteps, room));
  const gap = Math.min(MAX_TICK_GAP_MS, maxSpanMs / count);
  return Array.from({ length: count }, (_unused, index) => {
    const step = index + 1;
    return {
      atMs: Math.round(step * gap),
      value: start + direction * Math.round((distance * step) / count),
    };
  });
};

/**
 * When to tap for a jump across `units` positions that takes `spanMs` to draw.
 *
 * The first tap is on the press itself and the last as the board lands, with
 * the rest spread evenly between, so the finger feels the game wind past at
 * the speed the board shows it.
 */
export const burstOffsets = (units: number, spanMs: number, maxTaps = 7): number[] => {
  const room = Math.floor(Math.max(0, spanMs) / MIN_TICK_GAP_MS) + 1;
  const count = Math.max(0, Math.min(Math.floor(units), maxTaps, room));
  if (count <= 1) return count === 1 ? [0] : [];
  return Array.from({ length: count }, (_unused, index) =>
    Math.round((index * spanMs) / (count - 1)),
  );
};
