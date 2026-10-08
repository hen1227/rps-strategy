// Signing in with Apple, in a browser.
//
// A full-page navigation to Apple and back, for the reasons `discordAuth.web.ts`
// gives for Discord's: popups get blocked, and the fresh page load after the
// round trip is what this static export wants. The server owns the whole
// conversation with Apple, so this half only ever sees the URL to go to and,
// afterwards, the ticket on the callback page.
//
// See `appleAuth.ts` for the phone.

import type { AppleOutcome, AppleProviderKey, AppleStart } from './appleAuth.types';
import { ACCOUNT_CALLBACK_PATH } from './signInReturn';

/** The server's answer that governs this half: Apple's website. */
export const APPLE_PROVIDER: AppleProviderKey = 'appleWeb';

/**
 * Always true, and a constant for the reason `isDiscordSignInAvailable` is:
 * deriving it from `window` would make the pre-rendered page disagree with the
 * hydrated one. Whether the server can complete it is a separate question,
 * asked by `useSignInProviders`.
 */
export const isAppleSignInAvailable = () => true;

export const signInThroughApple = async (start: AppleStart): Promise<AppleOutcome> => {
  try {
    const origin = window.location?.origin ?? '';
    const authorizeUrl = await start.authorize(`${origin}${ACCOUNT_CALLBACK_PATH}`);
    window.location.assign(authorizeUrl);
  } catch (error) {
    return { kind: 'failed', message: error instanceof Error ? error.message : String(error) };
  }
  // The navigation is under way and this page is going away, so there is no
  // outcome to report and nothing after this will run.
  return { kind: 'pending' };
};
