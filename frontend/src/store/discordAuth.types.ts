// The contract the two halves of Discord sign-in are held to.
//
// Platform files are resolved by the bundler and never see each other, so a
// shared declaration is the only thing that can keep them in step. Same
// arrangement as `deviceStorage.types.ts` next door, for the same reason.
//
// The pure parser lives here rather than in either half because both need it:
// the web build reads the ticket off its own address bar, and the native build
// reads it off the URL the authentication sheet hands back. One definition,
// testable in Node.

/** Where Discord sends the browser back to. One definition, so the route and
 *  the redirect address cannot drift apart. */
export const ACCOUNT_CALLBACK_PATH = '/account/callback';

/**
 * What came of asking Discord.
 *
 * `pending` is the web answer and means "this page is going away" — the
 * redirect has been issued and nothing follows it, so there is deliberately no
 * ticket to return. Native resolves to `ticket` instead, because the sheet
 * closes and control comes back here.
 */
export type DiscordOutcome =
  | { kind: 'pending' }
  | { kind: 'ticket'; ticket: string }
  | { kind: 'cancelled' }
  | { kind: 'failed'; message: string };

/**
 * Turn this platform's own return address into the URL to open.
 *
 * Passed *in* rather than the address being passed *out*, so each half owns its
 * return address end to end: the web build knows its origin and the native
 * build knows its scheme, and neither has to be told by code that cannot know.
 */
export type Authorize = (redirectUri: string) => Promise<string>;

export interface DiscordAuth {
  /**
   * Whether this build can sign in with Discord at all.
   *
   * A real question on native, where the JavaScript may be running inside a
   * binary built before the browser module was added. Screens ask this rather
   * than which platform they are on, the same way they ask
   * `isEngineAvailable()`.
   */
  isDiscordSignInAvailable(): boolean;
  signInThroughDiscord(authorize: Authorize): Promise<DiscordOutcome>;
}

/**
 * Read the outcome out of a return address.
 *
 * Handles both shapes: `https://rps.henhen1227.com/account/callback?ticket=…`
 * on the web and `rps-strategy://account/callback?ticket=…` on a phone. The
 * query is split off by hand rather than through `new URL`, because a custom
 * scheme is not a "special" URL and engines disagree about what its parts are.
 */
export const ticketFromCallbackURL = (
  url: string,
): { ticket: string | null; error: string | null } => {
  const query = url.slice(url.indexOf('?') + 1);
  if (!url.includes('?') || !query) return { ticket: null, error: null };
  // The fragment is not ours, and leaving it on would make it part of the
  // last parameter's value.
  const parameters = new URLSearchParams(query.split('#')[0]);
  return {
    ticket: parameters.get('ticket') || null,
    error: parameters.get('error') || null,
  };
};

/**
 * Discord's error codes, in words somebody can act on.
 *
 * Shared rather than per-platform because both halves surface the same set:
 * the web build reads them off the callback address and the native build off
 * the URL the sheet returns.
 */
export const discordRefusalMessage = (code: string) => {
  switch (code) {
    case 'access_denied':
      return 'Discord sign-in was cancelled.';
    case 'expired':
      return 'That sign-in took too long. Try again.';
    case 'discord_unavailable':
      return 'Discord could not be reached. Try again in a moment.';
    default:
      return 'Discord sign-in did not work. Try again.';
  }
};
