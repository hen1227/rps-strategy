// Signing in with Discord, on a phone.
//
// `openAuthSessionAsync` is `ASWebAuthenticationSession` on iOS: a system sheet
// that shares Safari's cookies, so somebody already signed in to Discord is one
// tap from done. It intercepts the return scheme itself and hands the URL back,
// which is why the callback route is never rendered on the happy path here.
//
// Every native module is reached inside a function, never at module scope.
// Metro resolves this file only for native, but Node's test loader does not
// know that and resolves it for everything — so a module-scope import of
// `expo-web-browser` or `expo-linking` would break `npm test` the moment
// anything in the import graph reached this file. The same rule `push.ts`
// states for the same reason.
//
// See `discordAuth.web.ts` for the browser.

import { requireOptionalNativeModule } from 'expo';

import {
  ACCOUNT_CALLBACK_PATH,
  discordRefusalMessage,
  ticketFromCallbackURL,
  type Authorize,
  type DiscordOutcome,
} from './discordAuth.types';

/**
 * Whether this binary has the browser module linked in.
 *
 * A real question: the JavaScript can be newer than the app it is running
 * inside, and a build made before `expo-web-browser` was added has no way to
 * open the sheet. Asking beats offering a button that does nothing. The same
 * check `modules/rpsfish` uses for the engine.
 */
export const isDiscordSignInAvailable = () =>
  requireOptionalNativeModule('ExpoWebBrowser') !== null;

export const signInThroughDiscord = async (authorize: Authorize): Promise<DiscordOutcome> => {
  try {
    const { createURL } = await import('expo-linking');
    const WebBrowser = await import('expo-web-browser');

    const redirectUri = createURL(ACCOUNT_CALLBACK_PATH);
    const authorizeUrl = await authorize(redirectUri);
    const result = await WebBrowser.openAuthSessionAsync(authorizeUrl, redirectUri);

    if (result.type !== 'success') {
      // 'cancel' is the sheet's dismiss button and 'dismiss' is a swipe away.
      // Neither is a fault, and neither should raise an error banner.
      return { kind: 'cancelled' };
    }
    const { ticket, error } = ticketFromCallbackURL(result.url);
    if (error) return { kind: 'failed', message: discordRefusalMessage(error) };
    if (!ticket) return { kind: 'failed', message: 'Discord did not send anything back.' };
    return { kind: 'ticket', ticket };
  } catch (error) {
    return { kind: 'failed', message: error instanceof Error ? error.message : String(error) };
  }
};
