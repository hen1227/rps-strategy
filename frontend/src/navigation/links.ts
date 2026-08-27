// Every page's address, in one place.
//
// Expo Router takes a path, and a path written inline is a path that goes stale
// silently when a route file moves. These builders are the only thing that
// knows what a page is called, so renaming one is a change here and a rename
// of the file — and the compiler finds every caller.
//
// Note what is *not* here: no route takes a dynamic segment. Every parameter
// travels as a query string instead, which is what lets the site export as one
// HTML file per page: a dynamic segment would have to be pre-generated for
// every value it could ever take, and game ids are not knowable at build time.

import type { Href } from 'expo-router';

import { ACCOUNT_CALLBACK_PATH } from '@/store/discordAuth.types';
import { SITE_URL } from '@/store/serverConfig';
import type { ModeID } from '@/types/game';

export const links = {
  lobby: (): Href => '/',

  /** The live board: a real match, or a local game against a bot. */
  play: (): Href => '/play',

  /** The analysis board, optionally opened on a particular mode. */
  analysis: (modeId?: ModeID): Href =>
    modeId ? { pathname: '/analysis', params: { mode: modeId } } : '/analysis',

  /**
   * Post-game review of a stored game.
   *
   * A game with no server record — a bot game, or a pasted record — is handed
   * over through `useReviewHandoff` instead, because a PGN does not belong in
   * a URL.
   */
  review: (gameId?: string): Href =>
    gameId ? { pathname: '/review', params: { gameId } } : '/review',

  /**
   * Two bots playing each other, watched.
   *
   * A full-bleed page rather than a lobby section, and addressed at the top
   * level rather than under `/bots`, so that `/bots` belongs unambiguously to
   * the Bots section of the shell.
   */
  botBattle: (options: { mode?: ModeID; red?: string; blue?: string } = {}): Href => ({
    pathname: '/battle',
    params: {
      ...(options.mode ? { mode: options.mode } : {}),
      ...(options.red ? { red: options.red } : {}),
      ...(options.blue ? { blue: options.blue } : {}),
    },
  }),

  /** Playing bots: the practice ladder, the engines online, and their series. */
  bots: (): Href => '/bots',

  /**
   * One bot series: both engines, every game of the run, and its provenance.
   *
   * Under `/bots` rather than beside it, for the reason `myBots` gives about
   * `/account`: a run is something the Bots section is about, so arriving here
   * from somebody else's link leaves Bots lit in the sidebar, which is where
   * the rest of the runs are. The id travels as a query parameter for the
   * reason at the top of this file — series ids are not knowable at build time.
   */
  series: (seriesId: string): Href => ({
    pathname: '/bots/series',
    params: { series: seriesId },
  }),

  /**
   * The tournaments page, optionally opened on one event.
   *
   * A query parameter rather than a path segment, for the reason at the top of
   * this file: every page of this site exports as one static HTML file, and a
   * dynamic segment would have to be pre-generated for every tournament id that
   * will ever exist.
   */
  tournaments: (tournamentId?: string): Href =>
    tournamentId
      ? { pathname: '/tournaments', params: { tournament: tournamentId } }
      : '/tournaments',
  /**
   * The opening book, optionally opened on one line of one mode.
   *
   * A line travels as `?line=d8-c7,f2-g3` — the same spelling the book's own
   * routes use — which is what lets a badge on the board, or the prompt at the
   * end of a game, land on the page where that opening is named.
   */
  openings: (options: { mode?: ModeID; line?: readonly string[] } = {}): Href =>
    options.mode || options.line?.length
      ? {
          pathname: '/openings',
          params: {
            ...(options.mode ? { mode: options.mode } : {}),
            ...(options.line?.length ? { line: options.line.join(',') } : {}),
          },
        }
      : '/openings',
  leaderboard: (): Href => '/leaderboard',
  account: (): Href => '/account',

  /**
   * Where Discord sends the browser back to.
   *
   * The path comes from `discordAuth.types` rather than being written here,
   * because the platform modules build a redirect address out of it and the two
   * must be the same string. A mismatch would not fail loudly — it would fail
   * as a sign-in that lands on a page that is not listening.
   */
  accountCallback: (): Href => ACCOUNT_CALLBACK_PATH as Href,

  /**
   * The engines you own, and the handout for writing one.
   *
   * Under `/account` rather than under `/bots` because a bot belongs to an
   * account: the registry needs one to hang a token off, and the two documents
   * are the deep end of that flow rather than of the page where people play a
   * bot. Reading either therefore keeps Account lit in the sidebar, which is
   * where you came from.
   */
  myBots: (): Href => '/account/bots',
  botGuide: (): Href => '/account/bots/connect',
  botProtocol: (): Href => '/account/bots/protocol',
  admin: (): Href => '/admin',
  policy: (): Href => '/policy',
} as const;

/**
 * Any of the addresses above, written out whole for somebody who is not here.
 *
 * A `links` entry is what a page inside the app navigates with; this is the
 * same page pasted into a chat window, a post, or an email. It takes the
 * builder's own answer rather than a second copy of the path, so a route that
 * moves takes its shareable form with it — the review link used to be spelled
 * out a second time down here, which is one edit away from handing people a
 * URL that no longer exists.
 *
 * Nothing addressed this way is private: every page behind one of these reads
 * public archive routes, so a link handed to an opponent, a coach or a stranger
 * shows them what you were looking at.
 */
export const shareURL = (href: Href): string => {
  if (typeof href === 'string') return `${SITE_URL}${href}`;
  // Every builder above answers either a path or `{ pathname, params }`, which
  // is narrower than `Href` allows and is what makes this cast safe.
  const { pathname, params } = href as {
    pathname: string;
    params?: Record<string, string | number | undefined>;
  };
  // Escaped a parameter at a time rather than through `URLSearchParams`, which
  // is form encoding: it writes a space as `+`, and these are addresses rather
  // than a submitted form.
  const query = Object.entries(params ?? {})
    .filter(([, value]) => value !== undefined && value !== '')
    .map(([key, value]) => `${key}=${encodeURIComponent(String(value))}`)
    .join('&');
  return query ? `${SITE_URL}${pathname}?${query}` : `${SITE_URL}${pathname}`;
};

/** One game's review, for a link that leaves the app. */
export const gameReviewURL = (gameId: string) => shareURL(links.review(gameId));

/**
 * One run's page, for the same reason.
 *
 * A series is the occasion rather than the game: six games between two engines
 * are one thing that happened, and the answer to "how did that go" is the run
 * rather than whichever game somebody happened to be looking at.
 */
export const seriesURL = (seriesId: string) => shareURL(links.series(seriesId));

/**
 * The game this is all based on.
 *
 * Not a `links` entry because it is not a page of this site, and `Href` is a
 * promise that Expo Router can resolve it.
 */
export const YOUTUBE_URL = 'https://www.youtube.com/watch?v=qC3SO1s5L6Q';
