// Which page a path is, and whether the navigation already leads to it.
//
// Both answers are load-bearing and neither is visible from the page that
// depends on it. `sectionForPath` decides which row lights up, so a page whose
// address is a prefix of another's can silently light the wrong one; and
// `listedInNav` decides whether a page draws a back button, so an entry moving
// between the navigation and the pages *under* it changes a screen that does
// not mention the move. The three engine handouts are both cases at once: one
// row, three addresses, all under `/account/bots`, which is itself a row.

import assert from 'node:assert/strict';
import test from 'node:test';

import { listedInNav, sectionForPath, sectionsInGroup, type NavContext } from './sections.ts';
import { officialTournament } from '@/features/tournaments/officialTournament';
import type { Account } from '@/types/protocol';

/** Signed out, and no clock yet: what every page renders against at first. */
const GUEST: NavContext = { account: null, now: null };

/** Enough of an account for the visibility rules, which read two flags. */
const account = (flags: Partial<Account>): Account => flags as Account;

const at = (now: number, flags: Partial<Account> = {}): NavContext => ({
  account: account(flags),
  now,
});

test('the three handouts are one row of the navigation', () => {
  for (const path of [
    '/account/bots/connect',
    '/account/bots/protocol',
    '/account/bots/notation',
  ]) {
    assert.equal(sectionForPath(path)?.id, 'bot-docs', path);
  }
  const bots = sectionsInGroup('bots', GUEST).map((section) => section.id);
  assert.deepEqual(bots, ['bots', 'bot-docs']);
});

test('a longer address still beats a shorter one that covers three pages', () => {
  assert.equal(sectionForPath('/account')?.id, 'account');
  assert.equal(sectionForPath('/account/bots')?.id, 'my-bots');
  assert.equal(sectionForPath('/bots')?.id, 'bots');
  // A page *under* a section is that section for the purpose of lighting a row.
  assert.equal(sectionForPath('/bots/series')?.id, 'bots');
});

test('a page the navigation lists draws no way out of its own', () => {
  for (const path of [
    '/',
    '/bots',
    '/account/bots/connect',
    '/account/bots/protocol',
    '/account/bots/notation',
    '/credits',
    '/policy',
  ]) {
    assert.equal(listedInNav(path, GUEST), true, path);
  }
});

test('a page underneath one draws its own, and so does a page outside the shell', () => {
  // Sub pages: the navigation has a row for the section, not for these.
  assert.equal(listedInNav('/bots/series', GUEST), false);
  // Listed but unnamed — nobody navigates to "a player".
  assert.equal(listedInNav('/player', GUEST), false);
  // Listed, and pressing it takes the navigation away with it.
  assert.equal(listedInNav('/analysis', GUEST), false);
  // Not sections at all: the boards.
  assert.equal(listedInNav('/play', GUEST), false);
  assert.equal(listedInNav('/watch', GUEST), false);
  assert.equal(listedInNav('/review', GUEST), false);
  assert.equal(listedInNav('/battle', GUEST), false);
});

test('a row that is gated off gives its page the way out back', () => {
  // The registry is listed once Discord has vouched for the account, and until
  // then the page is reachable only from a link — so it carries a trail.
  assert.equal(listedInNav('/account/bots', GUEST), false);
  assert.equal(listedInNav('/account/bots', at(0, { discordVerified: false })), false);
  assert.equal(listedInNav('/account/bots', at(0, { discordVerified: true })), true);
});

test('the official event is a row while there is an event', () => {
  const during = officialTournament.startsAtUnixMs + 60_000;
  const after = officialTournament.endsAtUnixMs + 60_000;
  assert.equal(listedInNav('/tournament-info', at(during)), true);
  assert.equal(listedInNav('/tournament-info', at(after)), false);
  // Null until the browser has a clock, which is a row that is not on screen
  // yet — see `NavContext`. The trail is in the pre-rendered HTML for that one
  // render, rather than the page having no way out at all.
  assert.equal(listedInNav('/tournament-info', GUEST), false);
});

test('a trailing slash is the same page', () => {
  assert.equal(listedInNav('/credits/', GUEST), true);
  assert.equal(listedInNav('/account/bots/protocol/', GUEST), true);
});
