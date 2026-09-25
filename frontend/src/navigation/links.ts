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

  /**
   * A live game somebody else is playing, watched.
   *
   * Spectating used to be `/play` with a different board swapped in
   * underneath it, which made it the one thing here with no address: a refresh
   * dropped the viewer into their own empty lobby, and there was no link to
   * hand anybody. The game id travels in the query string for the reason at the
   * top of this file — game ids are not knowable at build time.
   *
   * Deliberately separate from `play` rather than a flag on it. They are not
   * the same page to be on: one is your game and the other is somebody else's,
   * and the address is the difference a person can see.
   *
   * A game that has already finished has no live board left to join, so this
   * address forwards to that game's review instead of failing. That is what
   * makes a watch link worth pasting: it keeps working after the game it names
   * is over.
   */
  watch: (gameId: string): Href => ({ pathname: '/watch', params: { gameId } }),

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

  /**
   * The opening explorer, optionally standing on one board.
   *
   * The same `?line=` spelling as the book, because it means the same thing:
   * the moves walked to get here. The explorer's numbers are about the board
   * that line reaches rather than about the line itself, so two orders share
   * an answer -- but a link still has to name a route, and a move list is the
   * only route a board has.
   */
  explorer: (options: { mode?: ModeID; line?: readonly string[] } = {}): Href =>
    options.mode || options.line?.length
      ? {
          pathname: '/explorer',
          params: {
            ...(options.mode ? { mode: options.mode } : {}),
            ...(options.line?.length ? { line: options.line.join(',') } : {}),
          },
        }
      : '/explorer',
  /**
   * The ladder, optionally opened on one mode's tab.
   *
   * The mode is in the address rather than only in state, for the reason
   * `admin` gives about its own tabs: it costs nothing, and it means the board
   * somebody is talking about can be linked to. Omitted opens the first
   * playable mode, so a bare `/leaderboard` is still a page.
   */
  leaderboard: (mode?: ModeID): Href =>
    mode ? { pathname: '/leaderboard', params: { mode } } : '/leaderboard',

  /**
   * One player's public page: their games, their rating, their titles.
   *
   * Takes a username, because that is what makes the address worth having —
   * `/player?user=yuki` is a link somebody can type or read out. A user id
   * also resolves, which is what lets a badge built from a game record link
   * here without looking a name up first.
   *
   * A query parameter rather than a path segment, for the reason at the top of
   * this file: a dynamic segment would have to be pre-generated for every name
   * that will ever exist.
   *
   * Not every name has a page. Player pages exist for accounts Discord has
   * vouched for, and for engines; an anonymous guest has none, and the page
   * says so rather than failing. So this may be built for any name without
   * checking first.
   */
  player: (handle: string): Href => ({ pathname: '/player', params: { user: handle } }),

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
  /** The recurring bot event, which has its own page because it is a place. */
  weekend: (): Href => '/weekend',

  /**
   * The hourly ranked rounds: who is entered, and what the last one produced.
   *
   * Addressed rather than left as a panel on `/leaderboard`, and the reason is
   * the same one `weekend` gives: this is a place, with an appointment attached
   * to it. The board is the result and this is the competition behind it, so an
   * owner asking "will my engine be in the next one" is not asking a question
   * about the standings — and the link handed to them in Discord has to land on
   * the answer rather than on a page they then have to scroll.
   */
  rounds: (): Href => '/rounds',
  myBots: (): Href => '/account/bots',
  botGuide: (): Href => '/account/bots/connect',
  botProtocol: (): Href => '/account/bots/protocol',
  botNotation: (): Href => '/account/bots/notation',
  /**
   * The host's screen, optionally opened on one of its tabs.
   *
   * The tab travels in the query string so it can be bookmarked and linked —
   * `/admin?tab=bots` is the engines — and for the reason at the top of this
   * file, which rules out a path segment for anything not knowable at build
   * time. Omitted opens the overview.
   */
  admin: (tab?: string): Href =>
    tab ? { pathname: '/admin', params: { tab } } : '/admin',
  policy: (): Href => '/policy',

  /** Themes, boards, piece sets and sounds. */
  appearance: (): Href => '/appearance',

  /**
   * Where this game came from, and the people it came from.
   *
   * A page rather than the bare YouTube link the sidebar used to carry: there
   * are two videos now, an official site to play the same games on, and a
   * Discord where the people who invented them are. One link out of four is not
   * a credit.
   */
  credits: (): Href => '/credits',

  /**
   * The licence of every third-party package the site and the app ship.
   *
   * Under the credits page rather than a section of its own. It answers the
   * same question for the software this is built on that Credits answers for
   * the games.
   */
  licences: (): Href => '/licences',

  /**
   * The feedback board: bugs, suggestions, and the host's answers.
   *
   * Three optional parameters, all of which exist to make one link do a job:
   *
   * - `item` opens the board on one thread. This is the shareable form —
   *   `feedbackItemURL` below wraps it — and it is why an item needs an
   *   address at all: a bug worth discussing is a bug somebody links to in
   *   Discord.
   * - `compose` opens the form, already set to a bug or a suggestion. The
   *   finished-game card uses it, so reporting what just went wrong is one tap
   *   rather than a page, a button and a dropdown.
   * - `gameId` travels with it, so a bug reported from a board arrives with the
   *   game attached. That is the difference between "the clock did something
   *   odd" and something reproducible.
   *
   * Query parameters rather than path segments, for the reason at the top of
   * this file: item ids are not knowable at build time.
   */
  feedback: (
    options: { item?: string; compose?: 'bug' | 'suggestion'; gameId?: string } = {},
  ): Href =>
    options.item || options.compose || options.gameId
      ? {
          pathname: '/feedback',
          params: {
            ...(options.item ? { item: options.item } : {}),
            ...(options.compose ? { compose: options.compose } : {}),
            ...(options.gameId ? { gameId: options.gameId } : {}),
          },
        }
      : '/feedback',

  /**
   * The official tournament, which is not run here and is not on the
   * `/tournaments` board.
   *
   * Deliberately its own address rather than an entry on that board: everything
   * there is an event of this site, with signups this server owns and matches
   * played on these boards. This is somebody else's event, on somebody else's
   * site, and the only thing this page can honestly do is say when it is and
   * point at it.
   */
  tournamentInfo: (): Href => '/tournament-info',
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

/**
 * Which page an address names, with its parameters left off.
 *
 * The one thing about an `Href` that several callers need and none of them
 * should be parsing: `usePathname` answers this for the page somebody is
 * standing on, and this answers it for a page they are about to go to, so the
 * two can be compared. `navigation/stack` compares them to tell going somewhere
 * else from opening the same page on different parameters.
 *
 * Every builder above answers either a path or `{ pathname, params }`, which is
 * narrower than `Href` allows and is what makes the cast safe — the same
 * narrowing, for the same reason, as `shareURL`.
 */
export const pageOf = (href: Href): string => {
  if (typeof href === 'string') return href.split('?')[0];
  return (href as { pathname: string }).pathname;
};

/** One game's review, for a link that leaves the app. */
export const gameReviewURL = (gameId: string) => shareURL(links.review(gameId));

/**
 * One live game, for somebody who should come and watch it now.
 *
 * The same link after the game ends is that game's review — see `links.watch` —
 * so this is safe to post about a game in progress without it rotting into a
 * dead end by the time anybody clicks it.
 */
export const watchGameURL = (gameId: string) => shareURL(links.watch(gameId));

/**
 * One player's page, for a link handed to somebody who is not here.
 *
 * By name rather than by id, always: the id is an implementation detail and the
 * name is the thing the link is for.
 */
export const playerURL = (handle: string) => shareURL(links.player(handle));

/**
 * The handle a `/player` address is asking for.
 *
 * `?user=` is the spelling this site writes — `links.player` emits it, and it
 * is what gets shared. `?bot=` is read beside it because an engine is a player
 * here rather than a separate kind of thing with a page of its own: a bot
 * holds an account, and its name is claimed out of the same namespace a
 * person's is. So `?bot=RPSFish` and `?user=RPSFish` *cannot* name two
 * different pages, and accepting both is what keeps that true for somebody who
 * guessed the other spelling — without a second namespace behind it, which is
 * the thing that would make the two names come apart.
 *
 * `user` wins when an address somehow carries both. It is already malformed at
 * that point, and the spelling this site writes is the one to believe.
 */
export const playerHandle = (params: { user?: string; bot?: string }): string =>
  params.user ?? params.bot ?? '';

/**
 * One item on the feedback board, for a link handed to somebody who is not
 * here.
 *
 * The reason the board addresses its items at all: a bug is discussed
 * somewhere else — Discord, usually — and the thing to paste there is the
 * thread, not the board.
 */
export const feedbackItemURL = (itemId: string) => shareURL(links.feedback({ item: itemId }));

/**
 * One run's page, for the same reason.
 *
 * A series is the occasion rather than the game: six games between two engines
 * are one thing that happened, and the answer to "how did that go" is the run
 * rather than whichever game somebody happened to be looking at.
 */
export const seriesURL = (seriesId: string) => shareURL(links.series(seriesId));

/**
 * The game this is all based on, and where its author is.
 *
 * Not `links` entries because none of these are pages of this site, and `Href`
 * is a promise that Expo Router can resolve one. They are gathered here for the
 * same reason the routes above are: an address written inline is an address
 * that goes stale where nobody is looking.
 *
 * This site is a fan build. WebGoatGuy invented these games and published them
 * in the two videos below; `PLAY_URL` is his own site, which is the official
 * place to play them and where the tournaments are held. The credits page is
 * the long version of that sentence.
 */
export const webGoatGuy = {
  /** The video the first modes came out of — v3 and v5 among them. */
  originalVideoURL: 'https://www.youtube.com/watch?v=qC3SO1s5L6Q',
  /** The later video, which introduced Intransitive — v6. */
  intransitiveVideoURL: 'https://www.youtube.com/watch?v=LO_zcGNJriA',
  /** The official site: his implementation, and where the tournaments are. */
  playURL: 'https://meaf.us/rps2/',
  /** The Intransitive Discord. */
  discordURL: 'https://discord.gg/QBXJte4YVm',
} as const;

/**
 * This project's own source. It is published under the AGPL, which expects a
 * network service to offer its source to the people using it, so the credits
 * page and the licences page both link here.
 */
export const SOURCE_URL = 'https://github.com/hen1227/rps-strategy';

/**
 * Where to get the iOS app. For now that is its TestFlight beta. Once the app
 * is on the App Store, put its App Store address here instead, and that is the
 * whole change: `iosAppIsBeta` reads which of the two this is from the address,
 * and the sidebar's button relabels itself to match.
 */
export const IOS_APP_URL = 'https://testflight.apple.com/join/Scqf8qzP';

/** Whether `IOS_APP_URL` is still the TestFlight beta rather than the App Store. */
export const iosAppIsBeta = IOS_APP_URL.startsWith('https://testflight.apple.com/');

/**
 * The original video, kept under its old name because several places link to
 * it directly.
 */
export const YOUTUBE_URL = webGoatGuy.originalVideoURL;
