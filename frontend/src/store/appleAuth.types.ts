// The contract the two halves of Apple sign-in are held to, for the reason
// `discordAuth.types.ts` gives: platform files are resolved by the bundler and
// never see each other.
//
// The halves do different things. The phone shows Apple's own sheet, which
// answers in place with a token Apple signed. The website sends the browser to
// Apple and back, the way Discord's sign-in does, and comes back to the same
// callback page with a ticket. What they share is everything after.

/**
 * What came of asking Apple.
 *
 * `credential` is the phone's answer: what Apple's sheet returned, for the
 * server to check, with the nonce it was asked to sign. `pending` is the
 * website's, and means "this page is going away".
 */
export type AppleOutcome =
  | { kind: 'credential'; nonce: string; identityToken: string; authorizationCode: string }
  | { kind: 'pending' }
  | { kind: 'cancelled' }
  | { kind: 'failed'; message: string };

/**
 * How each half asks the server to begin. The phone needs a nonce to hand to
 * Apple's sheet; the website needs an address to send the browser to, given its
 * own return address. Each half calls only the one it needs.
 */
export interface AppleStart {
  nonce: () => Promise<string>;
  authorize: (returnTo: string) => Promise<string>;
}

/**
 * Which of the server's answers says Apple can be offered here: `apple` for the
 * phone's sheet, `appleWeb` for the website's redirect, which needs more of the
 * server's configuration. See `useSignInProviders`.
 */
export type AppleProviderKey = 'apple' | 'appleWeb';

export interface AppleAuth {
  /**
   * Whether this build can show Apple's sign-in at all. A real question on a
   * phone, where the JavaScript may be running inside a binary built before
   * the module was added — and false on Android, which has no such sheet.
   */
  isAppleSignInAvailable(): boolean;
  signInThroughApple(start: AppleStart): Promise<AppleOutcome>;
  APPLE_PROVIDER: AppleProviderKey;
}
