import { requireOptionalNativeModule } from 'expo';
import * as ExpoHaptics from 'expo-haptics';
import { AppState, Platform, Vibration } from 'react-native';

import type { Haptics } from './haptics.types';
import { useFeelStore } from './preference';
import {
  ANDROID_MIN_API,
  BUZZ_FALLBACK,
  BUZZ_PATTERNS,
  HAPTIC_RECIPES,
  androidHapticFor,
  type BuzzMoment,
  type HapticEvent,
} from './recipes';

// The phones' half of the haptics layer: `haptics.ts` is the website's.
//
// Asked whether the *binary* has the native half before anything is played, the
// way `store/pushNative.ts` asks about notifications. Metro serves this bundle
// to every installed build, and every build made before expo-haptics was added
// has no such module: importing the package is harmless there (it looks the
// module up optionally), but every call would reject, and on Android the motor
// would be asked for without the VIBRATE permission the package's manifest
// brings with it. So a build without it simply has no haptics, and its
// settings page does not offer them.
//
// Everything here is fire and forget, and synchronous from the caller's side.
// A tap is answered at the moment of the touch or not at all: nothing awaits
// one, and a failure has nobody to tell.

const HAS_NATIVE = requireOptionalNativeModule('ExpoHaptics') !== null;

// An iPad has neither a Taptic Engine nor a motor; the generators answer
// nothing there. Rather than offer two switches that do nothing, it is treated
// as the build without haptics is.
const IS_IPAD = Platform.OS === 'ios' && Platform.isPad;

const ANDROID_API = typeof Platform.Version === 'number' ? Platform.Version : ANDROID_MIN_API;

/**
 * How soon the same moment may tap again.
 *
 * One touch can reach two code paths — a board and the screen around it — and
 * twenty milliseconds is shorter than any two touches a hand can make, so the
 * second is dropped. A refusal gets far longer, because the server repeats it:
 * a drop the board already knew was illegal is still sent, and the server's
 * `move_rejected` arrives a round trip after the board's own knock.
 */
const REPEAT_WINDOW_MS: Partial<Record<HapticEvent, number>> = { refused: 1500 };
const DEFAULT_REPEAT_WINDOW_MS = 20;
const lastFiredAt = new Map<HapticEvent, number>();

const play = (event: HapticEvent): Promise<void> => {
  if (Platform.OS === 'android') {
    return ExpoHaptics.performAndroidHapticsAsync(
      androidHapticFor(event, ANDROID_API) as ExpoHaptics.AndroidHaptics,
    );
  }
  const recipe = HAPTIC_RECIPES[event].ios;
  if (recipe.kind === 'impact') {
    return ExpoHaptics.impactAsync(recipe.style as ExpoHaptics.ImpactFeedbackStyle);
  }
  if (recipe.kind === 'notification') {
    return ExpoHaptics.notificationAsync(recipe.type as ExpoHaptics.NotificationFeedbackType);
  }
  return ExpoHaptics.selectionAsync();
};

const layer: Haptics = {
  haptic: (event) => {
    if (!HAS_NATIVE || IS_IPAD || !useFeelStore.getState().haptics) return;
    const now = Date.now();
    const last = lastFiredAt.get(event);
    const window = REPEAT_WINDOW_MS[event] ?? DEFAULT_REPEAT_WINDOW_MS;
    if (last !== undefined && now - last < window) return;
    lastFiredAt.set(event, now);
    play(event).catch(() => {
      // A phone that will not tap — Low Power Mode, the camera running, an
      // Android without the effect. The game goes on without it.
    });
  },

  buzz: (moment: BuzzMoment) => {
    // Only while the app is in front of somebody. Opening it from the match
    // alert brings the game up already started, and the alert has buzzed once.
    if (AppState.currentState !== 'active') return;
    if (layer.canVibrate() && useFeelStore.getState().vibration) {
      // iOS plays its own fixed vibration whatever it is handed, so the
      // pattern is Android's alone.
      if (Platform.OS === 'android') Vibration.vibrate([...BUZZ_PATTERNS[moment]]);
      else Vibration.vibrate();
      return;
    }
    layer.haptic(BUZZ_FALLBACK[moment]);
  },

  hapticsAvailable: () => HAS_NATIVE && !IS_IPAD,
  canVibrate: () => HAS_NATIVE && !IS_IPAD,
};

export const { buzz, canVibrate, haptic, hapticsAvailable } = layer;
