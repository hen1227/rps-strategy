import { analyticsAllowed, useAnalyticsConsent } from './consent';
import type { AnalyticsEventName, AnalyticsEvents, AnalyticsParams } from './events';
import type { AnalyticsTransport } from './transport.types';

// The one way an event leaves the app.
//
// Safe to import from anywhere, stores included: it reaches no platform API and
// no native module. The transport that does — gtag.js on the web, the relay in
// the apps — is handed in by `useAnalytics`, which only the root layout mounts.
// Until then, and in every unit test, `track` is a no-op.
//
// Consent is asked here, on every event, rather than by each caller: an event
// fired a moment after the player said no is the one that matters.

let transport: AnalyticsTransport | null = null;
let location = '/';

export const installTransport = (installed: AnalyticsTransport | null) => {
  transport = installed;
};

/** The page events are reported against, already stripped by `reportedPath`. */
export const setReportedLocation = (path: string) => {
  location = path;
};

export const reportedLocation = () => location;

export function track<Name extends AnalyticsEventName>(
  name: Name,
  ...[params]: AnalyticsEvents[Name] extends Record<string, never>
    ? []
    : [AnalyticsEvents[Name]]
): void {
  if (!transport || !analyticsAllowed(useAnalyticsConsent.getState())) return;
  try {
    transport.send(name, (params ?? {}) as AnalyticsParams, location);
  } catch {
    // Analytics never breaks the thing it is measuring.
  }
}
