import assert from 'node:assert/strict';
import test from 'node:test';

import { gameReviewURL, links, seriesURL, shareURL } from './links.ts';
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
