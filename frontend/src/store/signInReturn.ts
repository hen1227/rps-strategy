// What a sign-in that went through a browser leaves behind, for every provider.
//
// Discord's sign-in and Apple's on the website end the same way: the browser
// comes back to the app's callback page carrying a ticket, or the reason there
// is none. So the address, the parser and the words for each refusal live here
// rather than with either provider. One definition, testable in Node.

/** Where a browser sign-in sends the player back to. One definition, so the
 *  route and the return address cannot drift apart. */
export const ACCOUNT_CALLBACK_PATH = '/account/callback';

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
 * A refusal's code, in words somebody can act on.
 *
 * The codes are the providers' own where they have one — Discord's
 * `access_denied`, Apple's `user_cancelled_authorize` — and this server's for
 * everything else.
 */
export const signInRefusalMessage = (code: string) => {
  switch (code) {
    case 'access_denied':
    case 'user_cancelled_authorize':
      return 'Sign-in was cancelled.';
    case 'expired':
      return 'That sign-in took too long. Try again.';
    case 'discord_unavailable':
      return 'Discord could not be reached. Try again in a moment.';
    case 'apple_unavailable':
      return 'Apple could not be reached. Try again in a moment.';
    default:
      return 'Sign-in did not work. Try again.';
  }
};
