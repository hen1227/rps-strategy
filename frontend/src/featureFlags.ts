// What this build is allowed to show.
//
// Read at module scope on purpose. Metro replaces `process.env.NODE_ENV` and
// every `EXPO_PUBLIC_*` name with a string literal at build time — in the
// browser bundle *and* in the Node pass that pre-renders each page, since
// `app.json` sets `web.output: "static"`. Both halves of an export therefore
// agree about every flag here, which is what stops one from becoming a
// hydration mismatch and throwing the pre-rendered page away.
//
// `expo export` builds with `NODE_ENV=production`; `expo start` does not.

/** A bundle served by the dev server rather than one that was exported. */
export const IS_DEVELOPMENT = process.env.NODE_ENV !== 'production';

/**
 * The Reach study tool: reach maps, the interception rule, the race verdict.
 *
 * Development only for now. It is a tool for taking a game apart rather than a
 * feature of the site, and half of what it prints is a bound that needs a
 * caption to read correctly — neither belongs in front of a visitor yet.
 *
 * Nothing about it is reachable in an exported build: `useReach` is the single
 * gate, and with this false it reports the tool unavailable, so no screen draws
 * the toggle, the panel, or the overlay.
 *
 * To turn it on for one deploy without editing code, export with
 * `EXPO_PUBLIC_REACH_TOOL=on` **and `--clear`** — the value is inlined by a
 * Babel transform whose result Metro caches without the variable in the cache
 * key, so a warm cache silently ships the previous build's answer. To ship it
 * for good, delete this constant and its use in `hooks/useReach.ts`.
 */
export const REACH_TOOL_ENABLED =
  IS_DEVELOPMENT || process.env.EXPO_PUBLIC_REACH_TOOL === 'on';
