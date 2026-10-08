// Signing in with Apple, on a phone.
//
// Apple's own sheet, from `expo-apple-authentication`, with no browser in it:
// the sheet hands back an identity token Apple signed and a one-time code, and
// this hands both to the server, which checks the token against Apple's keys
// and redeems the code itself. No name and no email are asked for, so the sheet
// asks the player for nothing but a glance or a passcode.
//
// The package is reached inside a function, never at module scope, for the
// reason `discordAuth.ts` gives — and here it matters twice over. Loading
// `expo-apple-authentication` registers its button's native view, and a binary
// built before the module was added has no such view, so even importing it
// there throws. `isAppleSignInAvailable` is asked first, and nothing imports
// the package when it says no.
//
// See `appleAuth.web.ts` for the browser.

import { requireOptionalNativeModule } from 'expo';

import type { AppleOutcome, AppleProviderKey, AppleStart } from './appleAuth.types';

/** The server's answer that governs this half: Apple's sheet on the phone. */
export const APPLE_PROVIDER: AppleProviderKey = 'apple';

/**
 * Whether this binary has Apple's sign-in linked in. Null on Android, where the
 * package has no native half, and in any build made before it was added.
 */
export const isAppleSignInAvailable = () =>
  requireOptionalNativeModule('ExpoAppleAuthentication') !== null;

export const signInThroughApple = async (start: AppleStart): Promise<AppleOutcome> => {
  try {
    const AppleAuthentication = await import('expo-apple-authentication');
    const nonce = await start.nonce();
    // No scopes: the server needs only the opaque id Apple makes for this
    // app, which comes with every sign-in.
    const credential = await AppleAuthentication.signInAsync({ requestedScopes: [], nonce });
    if (!credential.identityToken) {
      return { kind: 'failed', message: 'Apple did not send anything back.' };
    }
    return {
      kind: 'credential',
      nonce,
      identityToken: credential.identityToken,
      authorizationCode: credential.authorizationCode ?? '',
    };
  } catch (error) {
    // The sheet's Cancel, and a swipe away. Neither is a fault, and neither
    // should raise an error banner.
    if ((error as { code?: unknown } | null)?.code === 'ERR_REQUEST_CANCELED') {
      return { kind: 'cancelled' };
    }
    return { kind: 'failed', message: error instanceof Error ? error.message : String(error) };
  }
};
