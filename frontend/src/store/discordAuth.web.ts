// Signing in with Discord, in a browser.
//
// A full-page navigation rather than a popup: popups get blocked, and this app
// is a static export where the fresh page load after the round trip is exactly
// what is wanted — the store reads the session back out of device storage on
// the way up, and the socket reconnects as the signed-in account.
//
// See `discordAuth.ts` for the native side.

import { ACCOUNT_CALLBACK_PATH, type Authorize, type DiscordOutcome } from './discordAuth.types';

/**
 * Always true, and deliberately a constant.
 *
 * Deriving it from `window` would make the pre-rendered page disagree with the
 * hydrated one, which throws the pre-render away. The same reasoning as
 * `isEngineAvailable` in `engineWorker.web.ts`.
 */
export const isDiscordSignInAvailable = () => true;

export const signInThroughDiscord = async (authorize: Authorize): Promise<DiscordOutcome> => {
  try {
    const origin = window.location?.origin ?? '';
    const authorizeUrl = await authorize(`${origin}${ACCOUNT_CALLBACK_PATH}`);
    window.location.assign(authorizeUrl);
  } catch (error) {
    return { kind: 'failed', message: error instanceof Error ? error.message : String(error) };
  }
  // The navigation is under way and this page is going away, so there is no
  // outcome to report and nothing after this will run.
  return { kind: 'pending' };
};
