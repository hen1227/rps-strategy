import type { BuzzMoment, HapticEvent } from './recipes';

/**
 * What the rest of the app may ask of the haptics layer.
 *
 * Declared apart from either half so that both must satisfy it. The halves
 * are picked by the bundler and never see each other — `haptics.ts` for the
 * website and the tests, `haptics.native.ts` for the phones — so a shared
 * declaration is the only thing that can keep them in step.
 */
export interface Haptics {
  /** Tap for a moment, if this phone can and its owner has not said not to. */
  haptic(event: HapticEvent): void;
  /** Buzz the motor, or tap instead for somebody who turned the motor off. */
  buzz(moment: BuzzMoment): void;
  /** Whether this build on this device can tap at all. */
  hapticsAvailable(): boolean;
  /** Whether this device has a motor worth offering a switch for. */
  canVibrate(): boolean;
}
