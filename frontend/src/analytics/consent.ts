import { create } from 'zustand';

import { deviceStorage } from '@/store/deviceStorage';

import { ANALYTICS_AVAILABLE } from './config';

// Whether this device may send usage stats, and whether it has to be asked.
//
// Two regimes, decided by where the device says it is:
//
//   - **Europe asks first.** In the EU, the EEA, the UK and Switzerland a
//     device identifier for analytics needs consent before it is set, so
//     nothing is sent until the player answers the one-time prompt.
//   - **Everywhere else is counted by default** and can turn it off under
//     Your account. A browser sending Global Privacy Control starts off,
//     because that is the user saying no in advance.
//
// "Where" is the time zone, not the address: the app never asks for a location
// and the website never looks one up, and a zone is enough to put somebody on
// the right side of this line. A zone that names nowhere — UTC, which is what a
// privacy-hardened browser reports — is treated as Europe, since asking is
// always allowed and not asking is not.
//
// A choice, once made, is this device's alone, like the engine preference: it
// is not part of the account's synced appearance, because consent given on a
// laptop is not consent given on a phone.

const CONSENT_KEY = 'rps.analytics.v1';

export type AnalyticsChoice = 'granted' | 'denied';

// The EU's outermost regions keep their own zones, so they are listed by name.
// Over-inclusion — Moscow, Istanbul, Kyiv — costs a prompt nobody needed;
// under-inclusion is the failure that matters.
const OPT_IN_ZONE =
  /^(Europe\/|Atlantic\/(Reykjavik|Canary|Madeira|Azores|Faroe)$|Arctic\/Longyearbyen$|Asia\/(Nicosia|Famagusta)$|Indian\/(Reunion|Mayotte)$|America\/(Guadeloupe|Martinique|Cayenne|St_Barthelemy|Marigot)$|Etc\/)/;

/** Whether a device in this time zone has to be asked before anything is sent. */
export const zoneRequiresOptIn = (timeZone: string | undefined | null): boolean => {
  // No slash is UTC, GMT or a zone this code does not know: nowhere to go by.
  if (!timeZone || !timeZone.includes('/')) return true;
  return OPT_IN_ZONE.test(timeZone);
};

const deviceTimeZone = (): string | undefined => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return undefined;
  }
};

/** A browser saying no in advance. Undefined everywhere but a browser that supports it. */
const globalPrivacyControl = (): boolean => {
  try {
    return (globalThis.navigator as { globalPrivacyControl?: boolean } | undefined)
      ?.globalPrivacyControl === true;
  } catch {
    return false;
  }
};

const readStoredChoice = (): AnalyticsChoice | null => {
  try {
    const stored = deviceStorage()?.getItem(CONSENT_KEY);
    return stored === 'granted' || stored === 'denied' ? stored : null;
  } catch {
    return null;
  }
};

const writeStoredChoice = (choice: AnalyticsChoice) => {
  try {
    deviceStorage()?.setItem(CONSENT_KEY, choice);
  } catch {
    // The choice lasts as long as this session does, and the prompt comes back
    // next time — which is the right failure for a consent that will not save.
  }
};

export interface AnalyticsConsentState {
  /** What the player chose here, or null for not yet. */
  choice: AnalyticsChoice | null;
  /** This device has to be asked before anything is sent. */
  optInRequired: boolean;
  /** The browser sent Global Privacy Control. */
  privacySignal: boolean;
}

// Read once at module load, like the engine preference. Under static rendering
// that read happens in Node too, where it finds nothing, so anything drawn from
// this store is drawn behind `useSettled`.
export const useAnalyticsConsent = create<AnalyticsConsentState>()(() => ({
  choice: readStoredChoice(),
  optInRequired: zoneRequiresOptIn(deviceTimeZone()),
  privacySignal: globalPrivacyControl(),
}));

/** Whether events may leave this device right now. */
export const analyticsAllowed = (
  state: AnalyticsConsentState,
  available = ANALYTICS_AVAILABLE,
): boolean => {
  if (!available) return false;
  if (state.choice) return state.choice === 'granted';
  return !state.optInRequired && !state.privacySignal;
};

/** Whether the one-time prompt is owed. */
export const consentPromptOwed = (
  state: AnalyticsConsentState,
  available = ANALYTICS_AVAILABLE,
): boolean => available && state.choice === null && state.optInRequired;

/** Record the player's answer, from the prompt or the settings row. */
export const setAnalyticsChoice = (choice: AnalyticsChoice) => {
  writeStoredChoice(choice);
  useAnalyticsConsent.setState({ choice });
};
