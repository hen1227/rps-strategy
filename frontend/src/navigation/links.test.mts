import assert from 'node:assert/strict';
import test from 'node:test';

import { gameReviewURL, links, pageOf, playerHandle, seriesURL, shareURL } from './links.ts';
import { SITE_URL } from '@/store/serverConfig';

test('a game review link is the review route, whole, with the id escaped', () => {
  assert.equal(gameReviewURL('abc123'), `${SITE_URL}/review?gameId=abc123`);
  assert.equal(gameReviewURL('a/b c'), `${SITE_URL}/review?gameId=a%2Fb%20c`);
});

test('the link and the route it shares point at the same page', () => {
  const href = links.review('abc123');
  assert.deepEqual(href, { pathname: '/review', params: { gameId: 'abc123' } });
  assert.ok(gameReviewURL('abc123').endsWith('/review?gameId=abc123'));
});

test('a series link is the run\'s own page, whole, with the id escaped', () => {
  assert.deepEqual(links.series('s1'), {
    pathname: '/bots/series',
    params: { series: 's1' },
  });
  assert.equal(seriesURL('s1'), `${SITE_URL}/bots/series?series=s1`);
  assert.equal(seriesURL('a/b c'), `${SITE_URL}/bots/series?series=a%2Fb%20c`);
});

test('a shareable address is built from the route builder, not beside it', () => {
  // Whatever `links` answers is what gets shared, so a route that moves cannot
  // leave a stale copy of its old path behind in a link somebody pasted.
  assert.equal(shareURL(links.lobby()), `${SITE_URL}/`);
  assert.equal(shareURL(links.review()), `${SITE_URL}/review`);
  assert.equal(shareURL(links.review('abc123')), gameReviewURL('abc123'));
  assert.equal(shareURL(links.series('s1')), seriesURL('s1'));
});

test('a shared address carries every parameter its route was given', () => {
  assert.equal(
    shareURL(links.openings({ mode: 'V5', line: ['d8-c7', 'f2-g3'] })),
    `${SITE_URL}/openings?mode=V5&line=d8-c7%2Cf2-g3`,
  );
  // An empty parameter is left off rather than sent as `key=`: the builders
  // already drop the ones they were not given, and a bare `?mode=` would be a
  // page asking itself to open on nothing.
  assert.equal(shareURL(links.openings()), `${SITE_URL}/openings`);
});

test('a player page answers to `bot=` as well as to the `user=` it shares', () => {
  // The two spellings are one page because a bot and a person claim names out
  // of one namespace. If this ever stopped holding, `?bot=x` and `?user=x`
  // could be two different players, which is the thing it exists to prevent.
  assert.equal(playerHandle({ user: 'RPSFish' }), 'RPSFish');
  assert.equal(playerHandle({ bot: 'RPSFish' }), 'RPSFish');
  assert.deepEqual(links.player('RPSFish'), {
    pathname: '/player',
    params: { user: 'RPSFish' },
  });
});

test('a player address with no handle is empty rather than undefined', () => {
  // The screen renders a placeholder for '' and would ask the server for
  // `undefined` otherwise.
  assert.equal(playerHandle({}), '');
});

test('the shared spelling wins over the alias', () => {
  assert.equal(playerHandle({ user: 'yuki', bot: 'RPSFish' }), 'yuki');
});

test('every address names a page, whichever form the builder answers in', () => {
  // `navigation/stack` compares this against `usePathname` to tell going
  // somewhere else from opening the same page on different parameters, and a
  // path it cannot read would silently make every move look like the former.
  // So it is asserted over the builders themselves rather than over two
  // examples: a builder that grew a third answer shape would land here.
  const everyAddress = [
    links.lobby(),
    links.play(),
    links.watch('g1'),
    links.analysis(),
    links.analysis('V5'),
    links.review(),
    links.review('g1'),
    links.botBattle(),
    links.botBattle({ mode: 'V5', red: 'a', blue: 'b' }),
    links.bots(),
    links.series('s1'),
    links.tournaments(),
    links.tournaments('t1'),
    links.openings(),
    links.openings({ mode: 'V5', line: ['d8-c7'] }),
    links.explorer(),
    links.explorer({ mode: 'V5', line: ['d8-c7'] }),
    links.leaderboard(),
    links.leaderboard('V5'),
    links.player('yuki'),
    links.account(),
    links.accountCallback(),
    links.weekend(),
    links.myBots(),
    links.botGuide(),
    links.botProtocol(),
    links.botNotation(),
    links.admin(),
    links.admin('bots'),
    links.policy(),
    links.credits(),
    links.tournamentInfo(),
  ];

  for (const href of everyAddress) {
    const page = pageOf(href);
    assert.ok(page.startsWith('/'), `${JSON.stringify(href)} names ${page}`);
    assert.ok(!page.includes('?'), `${page} carries its parameters`);
  }
});

test('a page is the same page whatever it is opened on', () => {
  // The one comparison the rule above turns on: two addresses for one screen
  // read as one page, and two screens do not.
  assert.equal(pageOf(links.watch('a')), pageOf(links.watch('b')));
  assert.equal(pageOf(links.review()), pageOf(links.review('a')));
  assert.equal(pageOf(links.analysis()), pageOf(links.analysis('V5')));
  assert.notEqual(pageOf(links.play()), pageOf(links.watch('a')));
  assert.notEqual(pageOf(links.lobby()), pageOf(links.leaderboard()));
});
