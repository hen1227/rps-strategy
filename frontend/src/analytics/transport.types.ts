import type { AnalyticsParams } from './events';

/**
 * How events leave this device. Declared apart from both implementations so
 * that each must satisfy it: the web's is gtag.js, the apps' is this server's
 * relay, and the bundler picks one.
 */
export interface AnalyticsTransport {
  /** Consent is in hand: load what is needed and start sending. Idempotent. */
  start(): void;
  /** Consent was withdrawn: stop, and forget this device's analytics identity. */
  stop(): void;
  /** One event. `location` is the reported page, already stripped of anything personal. */
  send(name: string, params: AnalyticsParams, location: string): void;
}
