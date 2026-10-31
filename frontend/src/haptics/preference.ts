import { create } from 'zustand';

import { deviceStorage } from '@/store/deviceStorage';

// Whether this phone taps, and whether it buzzes.
//
// Two switches rather than one, because they are different promises. Haptics
// answer a touch, under the finger that made it. Vibration is the motor, for
// the moments a player may not be looking at all — a game starting, a clock
// running low — and somebody can reasonably want either without the other.
//
// Both on unless turned off. A phone that taps is what a phone game feels like,
// and the buzz fires twice in a game at most.
//
// Per device, like the engine switch beside the review, and deliberately *not*
// part of the account's synced appearance: the server's appearance is a closed
// list of four ids and refuses the whole save over a fifth, and the switch is
// about the phone in your hand anyway — the same account on a laptop has
// nothing to tap with.

const HAPTICS_KEY = 'rps.haptics.v1';
const VIBRATION_KEY = 'rps.vibration.v1';

/**
 * What a stored value means: only an explicit `off` turns a switch off.
 *
 * Anything else, including nothing stored and a value this build does not
 * recognise, reads as on — the default, rather than a guess at what somebody
 * meant by a value nobody wrote.
 */
export const switchFromStored = (stored: string | null | undefined): boolean => stored !== 'off';

const readSwitch = (key: string): boolean => {
  try {
    return switchFromStored(deviceStorage()?.getItem(key));
  } catch {
    // A device store that will not open. Not worth a broken launch, and the
    // default is the answer the player has not changed yet.
    return true;
  }
};

const writeSwitch = (key: string, on: boolean) => {
  try {
    deviceStorage()?.setItem(key, on ? 'on' : 'off');
  } catch {
    // The choice lasts as long as this session does.
  }
};

interface FeelState {
  haptics: boolean;
  vibration: boolean;
}

// Read once, at module load, as the engine switch is: the dispatcher asks this
// on every tap, and a store already holding the answer is what lets it ask
// without React and without waiting.
export const useFeelStore = create<FeelState>()(() => ({
  haptics: readSwitch(HAPTICS_KEY),
  vibration: readSwitch(VIBRATION_KEY),
}));

export const useHapticsEnabled = () => useFeelStore((state) => state.haptics);
export const useVibrationEnabled = () => useFeelStore((state) => state.vibration);

/** Turn the taps on or off, and remember it. */
export const setHaptics = (on: boolean) => {
  writeSwitch(HAPTICS_KEY, on);
  useFeelStore.setState({ haptics: on });
};

/** Turn the buzz on or off, and remember it. */
export const setVibration = (on: boolean) => {
  writeSwitch(VIBRATION_KEY, on);
  useFeelStore.setState({ vibration: on });
};
