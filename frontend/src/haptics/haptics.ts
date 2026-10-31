import type { Haptics } from './haptics.types';
import type { BuzzMoment, HapticEvent } from './recipes';

// The website's half of the haptics layer, and the half Node resolves for the
// tests: it does nothing.
//
// A browser's only lever is `navigator.vibrate`, which iOS Safari and every
// desktop ignore and Android's Chrome answers with the motor — a buzz where a
// tap was meant, on the one browser that would feel it. So the website has no
// haptics, the settings for them are not drawn there, and this file keeps
// `expo-haptics` out of the web bundle altogether. The phones' half is
// `haptics.native.ts`.

const layer: Haptics = {
  haptic: (_event: HapticEvent) => {},
  buzz: (_moment: BuzzMoment) => {},
  hapticsAvailable: () => false,
  canVibrate: () => false,
};

export const { buzz, canVibrate, haptic, hapticsAvailable } = layer;
