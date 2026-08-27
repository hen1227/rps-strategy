export const WS_URL = process.env.EXPO_PUBLIC_WS_URL ?? 'ws://localhost:8080/ws';

const apiURLFromWebSocket = (webSocketURL: string) =>
  webSocketURL
    .replace(/^wss:/, 'https:')
    .replace(/^ws:/, 'http:')
    .replace(/\/ws(?:\?.*)?$/, '');

export const API_URL = (
  process.env.EXPO_PUBLIC_API_URL ?? apiURLFromWebSocket(WS_URL)
).replace(/\/$/, '');

/**
 * Where this deployment is served from, for a URL that leaves the app.
 *
 * A link somebody pastes into a chat window needs an origin on the front of
 * it, and the app knows two different things about that. On the web the
 * browser already knows, and its answer is the right one even in development:
 * a link copied off a dev server has to point back at that dev server. A
 * native build has no such thing, so it falls back to the deployed site — the
 * same origin `expo-router` is configured with in `app.json`, which is where
 * this has to stay in step.
 *
 * Not for rendering. Under static web rendering this evaluates once in Node at
 * build time and again in the browser, and the two answers differ, so putting
 * it on screen would be a hydration mismatch. Read it in an event handler.
 */
const servedFrom =
  process.env.EXPO_PUBLIC_SITE_URL ??
  (typeof window === 'undefined' ? '' : (window.location?.origin ?? ''));

export const SITE_URL = servedFrom.replace(/\/$/, '') || 'https://rps.henhen1227.com';
