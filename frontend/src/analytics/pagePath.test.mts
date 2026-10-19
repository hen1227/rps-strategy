import assert from 'node:assert/strict';
import test from 'node:test';

import { contentTypeOf, reportedPath } from './pagePath.ts';

// Every parameter that names somebody, or is a secret, on the routes that take
// one. If any of these reaches Google, a report is a list of who did what.
test('a page is reported without anything that names a person or a game', () => {
  assert.equal(reportedPath('/player', '?user=henhen1227'), '/player');
  assert.equal(reportedPath('/player', '?bot=bot-123'), '/player');
  assert.equal(reportedPath('/account/callback', '?ticket=secret&error='), '/account/callback');
  assert.equal(reportedPath('/watch', '?gameId=abc'), '/watch');
  assert.equal(reportedPath('/review', '?gameId=abc'), '/review');
  assert.equal(reportedPath('/feedback', '?item=7&gameId=abc&compose=bug'), '/feedback');
  assert.equal(reportedPath('/bots/series', '?series=s-1'), '/bots/series');
  assert.equal(reportedPath('/tournaments', '?tournament=t-1'), '/tournaments');
});

test('the kind of page is kept', () => {
  assert.equal(reportedPath('/analysis', '?mode=V6&gameId=abc'), '/analysis?mode=V6');
  assert.equal(reportedPath('/admin', new URLSearchParams({ tab: 'reports' })), '/admin?tab=reports');
});

test('a kept name carrying something that is not a slug is dropped', () => {
  assert.equal(reportedPath('/analysis', '?mode=someone%40example.com'), '/analysis');
  assert.equal(reportedPath('/analysis', `?mode=${'x'.repeat(40)}`), '/analysis');
});

test('a path that arrives with its own query or hash is cut at it', () => {
  assert.equal(reportedPath('/player?user=henhen1227#top'), '/player');
  assert.equal(reportedPath(''), '/');
});

test('a shared link is reported as the kind of page it opens', () => {
  assert.equal(contentTypeOf('https://rps.henhen1227.com/review?gameId=abc'), 'review');
  assert.equal(contentTypeOf('https://rps.henhen1227.com/player?user=henhen1227'), 'player');
  assert.equal(contentTypeOf('https://rps.henhen1227.com/bots/series?series=1'), 'bots');
  assert.equal(contentTypeOf('https://rps.henhen1227.com/'), 'home');
});
