import Constants from 'expo-constants';
import * as Device from 'expo-device';
import { Dimensions, PixelRatio, Platform } from 'react-native';

import type { RelayFacts } from './relay';

// What the apps say about themselves in a batch: the coarse facts Google would
// read off a browser's user agent, which a native app has to state.
//
// Native modules at module scope, so this file is reached only through
// `await import`, from `transport.ts` — never by the static export or a unit
// test. The same arrangement as `store/pushNative.ts`.

const locale = (): string => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().locale ?? '';
  } catch {
    return '';
  }
};

export const readDeviceFacts = (): RelayFacts => {
  const language = locale();
  const screen = Dimensions.get('screen');
  const scale = PixelRatio.get();
  return {
    platform: Platform.OS,
    appVersion: (Constants.expoConfig?.version ?? '').trim(),
    device: {
      category: Device.deviceType === Device.DeviceType.TABLET ? 'tablet' : 'mobile',
      os: Platform.OS === 'ios' ? 'iOS' : 'Android',
      osVersion: Device.osVersion ?? String(Platform.Version ?? ''),
      model: Device.modelName ?? '',
      brand: Device.brand ?? '',
      language,
      screen: `${Math.round(screen.width * scale)}x${Math.round(screen.height * scale)}`,
      // The region subtag of the locale: en-GB's GB. A setting, not a place.
      region: /-([A-Z]{2})(?:-|$)/.exec(language)?.[1] ?? '',
    },
  };
};
