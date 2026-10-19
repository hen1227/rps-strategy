import { useSyncExternalStore } from 'react';
import { AccessibilityInfo } from 'react-native';

// Whether the player has asked their device for less motion: Reduce Motion on
// iOS, Remove animations on Android, `prefers-reduced-motion` in a browser. All
// three arrive through `AccessibilityInfo`, and all three can change while the
// app is open, so the answer is followed rather than read once.
//
// One subscription for the whole app rather than one per caller, and never
// removed. react-native-web files each listener under the handler converted to
// a string, and every `useState` setter converts to the same string, so a
// second subscriber's removal would take the first one's listener with it.

let reduced = false;
let listening = false;
const subscribers = new Set<() => void>();

const settle = (value: boolean) => {
  if (value === reduced) return;
  reduced = value;
  subscribers.forEach((notify) => notify());
};

const subscribe = (notify: () => void) => {
  subscribers.add(notify);
  if (!listening) {
    listening = true;
    AccessibilityInfo.isReduceMotionEnabled().then(settle, () => {});
    AccessibilityInfo.addEventListener('reduceMotionChanged', settle);
  }
  return () => {
    subscribers.delete(notify);
  };
};

/**
 * Whether motion should be kept to what the player needs.
 *
 * `false` until the platform answers, which is within a frame of the first
 * board mounting — long before anything on it could move. The pre-rendered
 * pages of the site have no platform to ask and say `false` too.
 */
export const useReducedMotion = () =>
  useSyncExternalStore(
    subscribe,
    () => reduced,
    () => false,
  );
