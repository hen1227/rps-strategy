import assert from 'node:assert/strict';
import test from 'node:test';

import { openGameCards, type OpenGamesSource } from './openGames.ts';
import type { Challenge } from '../../types/protocol.ts';

const ME = 'me-0000';

const challenge = (id: string, userId: string, overrides: Partial<Challenge> = {}): Challenge =>
  ({
    id,
    challenger: { userId, username: userId },
    modeName: 'Intransitive',
    setup: { modeId: 'V6' },
    present: true,
    createdAtUnixMs: 1_000,
    ...overrides,
  }) as Challenge;

const source = (overrides: Partial<OpenGamesSource> = {}): OpenGamesSource => ({
  incomingChallenges: [],
  outgoingChallenge: null,
  openChallenges: [],
  challengeNotice: null,
  accountId: ME,
  ...overrides,
});

const keys = (value: OpenGamesSource) => openGameCards(value).map((card) => card.key);

test('an empty lobby has no cards', () => {
  assert.deepEqual(openGameCards(source()), []);
});

test('what is yours to answer comes first, then yours, then the notice, then everybody else', () => {
  const mine = challenge('c-mine', ME, { targetUsername: 'alice' });
  const cards = keys(
    source({
      incomingChallenges: [challenge('c-in', 'bob', { targetUsername: 'me' })],
      outgoingChallenge: mine,
      challengeNotice: 'Your search ended while you were offline.',
      openChallenges: [challenge('c-open', 'carol')],
    }),
  );
  assert.deepEqual(cards, ['in:c-in', 'out:c-mine', 'notice', 'open:c-open']);
});

test('a new open game joins the end of the row, so the cards already there stay put', () => {
  const older = challenge('c-older', 'bob', { createdAtUnixMs: 1_000 });
  const newer = challenge('c-newer', 'carol', { createdAtUnixMs: 2_000 });
  // The server sends the whole board each time, in whatever order it likes.
  assert.deepEqual(keys(source({ openChallenges: [newer, older] })), [
    'open:c-older',
    'open:c-newer',
  ]);
  const arriving = challenge('c-arriving', 'dave', { createdAtUnixMs: 3_000 });
  assert.deepEqual(keys(source({ openChallenges: [arriving, newer, older] })), [
    'open:c-older',
    'open:c-newer',
    'open:c-arriving',
  ]);
});

test('your own search is the floating bar’s, and your own posted game appears once', () => {
  const mySearch = challenge('c-search', ME, { queued: true });
  const myPost = challenge('c-post', ME);
  const cards = openGameCards(
    source({ outgoingChallenge: myPost, openChallenges: [mySearch, myPost] }),
  );
  assert.deepEqual(
    cards.map((card) => card.key),
    ['out:c-post'],
  );
});

test('an invitation addressed to somebody is never offered to the lobby', () => {
  const private_ = challenge('c-private', 'bob', { targetUsername: 'erin' });
  assert.deepEqual(keys(source({ openChallenges: [private_] })), []);
});

test('an incoming challenge the server also lists is not drawn twice', () => {
  const both = challenge('c-both', 'bob');
  assert.deepEqual(keys(source({ incomingChallenges: [both], openChallenges: [both] })), [
    'in:c-both',
  ]);
});

test('a blank notice is no notice', () => {
  assert.deepEqual(keys(source({ challengeNotice: '   ' })), []);
  assert.deepEqual(keys(source({ challengeNotice: ' Declined. ' })), ['notice']);
});
