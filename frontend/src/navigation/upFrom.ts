// Where "back" goes, for every page that has a back.
//
// This is the answer to one question — *which page is this page underneath* —
// and it is written down once because it used to be answered five different
// ways. Three screens drew a bare `‹` chip and called `router.back()`; the board
// and the watch screen drew nothing at the top at all and hid the way out in a
// button on the right of the status card; the pages under `/account` carried a
// line of faint text; and `/player`, `/credits`, `/policy` and
// `/tournament-info` carried nothing and lit nothing in the sidebar either.
//
// `router.back()` is the part that was broken rather than merely inconsistent.
// It walks the browser's history, and history is not this question. From a
// watched game the previous entry is very often another board that has since
// finished, or a review of a game the archive has not written yet — so "back"
// landed on "this game cannot be reviewed" and the real way out took two or
// three presses. A page's parent does not depend on how somebody got there, so
// this table does not either, which is also what makes the answer survive a
// refresh, a pasted link, and a cold open from a notification: none of those
// have any history to walk.
//
// Sections of the shell deliberately have no entry here. The sidebar and the
// tab bar are already the way out of those, and a back button beside them would
// be a second answer to a question already answered — the reasoning
// `ScreenShell` has always given. What this adds is every page that is *not*
// one of those.
//
// Named entries rather than a lookup by path, for the reason `links.ts` gives
// about its own builders: a caller naming `up.review` is a caller the compiler
// can find when this moves, and a string typed at the call site is not.

import type { Href } from 'expo-router';

import { links } from './links';

export interface UpTarget {
  /** What the page one level up is called, on the button. */
  label: string;
  href: Href;
}

const LOBBY: UpTarget = { label: 'Lobby', href: links.lobby() };
const BOTS: UpTarget = { label: 'Bots', href: links.bots() };
const MY_BOTS: UpTarget = { label: 'Your bots', href: links.myBots() };

export const up = {
  /** Your own board. Every way onto it starts at the lobby. */
  play: LOBBY,
  /**
   * Somebody else's board.
   *
   * The lobby rather than whichever list the watcher came from — the live rail,
   * a tournament, a run — because the lobby is the one page that lists every
   * game going on, and it is the only answer that is still true after a refresh
   * or on a link handed to somebody else.
   */
  watch: LOBBY,
  analysis: LOBBY,
  /**
   * A stored game.
   *
   * The fallback, not the whole answer: a game that belongs to a bot series
   * belongs under that run, and the review screen passes its own target when it
   * has one. A review reached from anywhere else — the lobby's history, a
   * player's page, the admin board — goes to the lobby.
   */
  review: LOBBY,
  /** Two engines playing. Launched from the Bots page, and only from there. */
  battle: BOTS,
  series: BOTS,
  myBots: { label: 'Account', href: links.account() } as UpTarget,
  /** The three handouts for writing an engine, which sit under your bots. */
  botDoc: MY_BOTS,
  /** The list of players is the one page whose subject is everybody. */
  player: { label: 'Leaderboard', href: links.leaderboard() } as UpTarget,
  credits: LOBBY,
  policy: LOBBY,
  tournamentInfo: { label: 'Tournaments', href: links.tournaments() } as UpTarget,
} as const satisfies Record<string, UpTarget>;
