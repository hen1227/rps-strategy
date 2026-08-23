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

  /** Two bots playing each other, watched. */
  botBattle: (options: { mode?: ModeID; red?: string; blue?: string } = {}): Href => ({
    pathname: '/bots/battle',
    params: {
      ...(options.mode ? { mode: options.mode } : {}),
      ...(options.red ? { red: options.red } : {}),
      ...(options.blue ? { blue: options.blue } : {}),
    },
  }),

  /** The handout for bot authors. */
  bots: (): Href => '/bots',

  tournaments: (): Href => '/tournaments',
  openings: (): Href => '/openings',
  account: (): Href => '/account',
  admin: (): Href => '/admin',
  policy: (): Href => '/policy',
} as const;
