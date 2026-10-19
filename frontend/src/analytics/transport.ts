import { AppState } from 'react-native';

import { IS_DEVELOPMENT } from '@/featureFlags';
import { deviceStorage } from '@/store/deviceStorage';
import { API_URL, SITE_URL } from '@/store/serverConfig';

import { createRelayTransport, type RelayFacts } from './relay';

// The apps' transport: the relay in `relay.ts`, wired to the phone.
//
// Imported only by `useAnalytics`, which only the root layout mounts, so no
// store and no test ever loads `AppState` through it.

let facts: Promise<RelayFacts> | null = null;

export const transport = createRelayTransport({
  now: () => Date.now(),
  random: () => Math.random(),
  storage: deviceStorage,
  post: async (batch) => {
    await fetch(`${API_URL}/api/analytics`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(batch),
    });
  },
  facts: () => (facts ??= import('./deviceFacts').then((module) => module.readDeviceFacts())),
  onForeground: (listener) => {
    const subscription = AppState.addEventListener('change', (state) =>
      listener(state === 'active'),
    );
    return () => subscription.remove();
  },
  setTimer: (callback, ms) => setTimeout(callback, ms),
  clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  origin: SITE_URL,
  debug: IS_DEVELOPMENT,
});
