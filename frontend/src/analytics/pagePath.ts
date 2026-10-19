// What a page is called when it is reported.
//
// Every parameter on this site is in the query string — no route has a dynamic
// segment (`navigation/links.ts`) — and several of them name somebody: a
// profile's `user`, a game's `gameId` (whose record prints both players), a
// feedback `item`, a series, a tournament, and the one-time `ticket` a sign-in
// comes back with. So the query is dropped, and only parameters that describe a
// *kind* of page rather than a particular one are put back.
//
// The title is the path for the same reason. The document's own title is not
// safe to send — a profile's is the player's name — and a path reads just as
// well in a report.

const KEPT_PARAMETERS = ['mode', 'tab'] as const;

/** The path and the harmless part of the query, for a page view. */
export const reportedPath = (pathname: string, search: string | URLSearchParams = ''): string => {
  const path = pathname.split(/[?#]/)[0] || '/';
  const query = typeof search === 'string' ? new URLSearchParams(search) : search;
  const kept = new URLSearchParams();
  for (const name of KEPT_PARAMETERS) {
    const value = query.get(name);
    // A mode or a tab is a short slug. Anything else under those names is not
    // one of ours and is not passed on.
    if (value && /^[a-z0-9_-]{1,32}$/i.test(value)) kept.set(name, value);
  }
  const rest = kept.toString();
  return rest ? `${path}?${rest}` : path;
};

/** The kind of page a link opens, for `share`. Never which one. */
export const contentTypeOf = (url: string): string => {
  let path: string;
  try {
    path = new URL(url, 'https://example.invalid').pathname;
  } catch {
    return 'link';
  }
  const first = path.split('/').filter(Boolean)[0];
  return first ? first.replace(/[^a-z0-9_-]/gi, '').slice(0, 32) || 'link' : 'home';
};
