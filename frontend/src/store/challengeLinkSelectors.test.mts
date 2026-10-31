import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applyChallengeLink,
  asSentence,
  authorWhereabouts,
  challengeLinkRole,
  challengeLinksOnConnect,
  emptyChallengeLinkSlots,
  linkExpiryLabel,
  linkStatusLine,
  linkTitle,
  type ChallengeLinkSlots,
} from './challengeLinkSelectors.ts';
import type { ChallengeLink } from '../types/protocol.ts';

const NOW = 1_800_000_000_000;
const alice = { userId: 'alice', username: 'Alice' };
const bob = { userId: 'bob', username: 'Bob' };

const open = (overrides: Partial<ChallengeLink> = {}): ChallengeLink => ({
  code: 'k7Q2xP9mAb',
  challenger: alice,
  modeName: 'Intransitive',
  state: 'open',
  createdAtUnixMs: NOW,
  expiresAtUnixMs: NOW + 3_600_000,
  ...overrides,
});

const waiting = (overrides: Partial<ChallengeLink> = {}): ChallengeLink =>
  open({
    state: 'waiting',
    taker: bob,
    expiresAtUnixMs: undefined,
    authorStatus: 'away',
    authorCalled: true,
    ...overrides,
  });

const started = (gameId = 'game-1'): ChallengeLink =>
  open({ state: 'started', taker: bob, gameId, expiresAtUnixMs: undefined });

const closed = (code = 'k7Q2xP9mAb'): ChallengeLink => ({ code, state: 'closed' });

const as = (accountId: string, ownGameId: string | null = null) => ({ accountId, ownGameId });

test('the part an account plays is read off the two profiles', () => {
  assert.equal(challengeLinkRole(waiting(), 'alice'), 'author');
  assert.equal(challengeLinkRole(waiting(), 'bob'), 'taker');
  assert.equal(challengeLinkRole(waiting(), 'cleo'), 'viewer');
  // A closed link names nobody, so nobody is its author any more.
  assert.equal(challengeLinkRole(closed(), 'alice'), 'viewer');
  assert.equal(challengeLinkRole(open(), null), 'viewer');
});

test("an author holds their link until it becomes a game, and the seated tab gets the popup", () => {
  let slots: ChallengeLinkSlots = emptyChallengeLinkSlots;
  slots = applyChallengeLink(slots, open(), null, as('alice')).slots;
  assert.equal(slots.ownLink?.state, 'open');
  slots = applyChallengeLink(slots, waiting(), null, as('alice')).slots;
  assert.equal(slots.ownLink?.state, 'waiting');
  assert.equal(slots.awaitedLink, null, 'the author is not waiting on their own link');

  const seated = applyChallengeLink(slots, started('game-1'), null, as('alice', 'game-1')).slots;
  assert.equal(seated.ownLink, null);
  assert.equal(seated.acceptedLink?.taker?.username, 'Bob');

  // Another tab of the same author hears it too, and is not the one playing.
  const elsewhere = applyChallengeLink(slots, started('game-1'), null, as('alice', null)).slots;
  assert.equal(elsewhere.ownLink, null);
  assert.equal(elsewhere.acceptedLink, null);
});

test('a taker holds the wait until it ends, however it ends', () => {
  let slots = applyChallengeLink(emptyChallengeLinkSlots, waiting(), null, as('bob')).slots;
  assert.equal(slots.awaitedLink?.taker?.userId, 'bob');
  assert.equal(slots.ownLink, null);

  // Let go: the link is open again and names no taker.
  slots = applyChallengeLink(slots, open(), null, as('bob')).slots;
  assert.equal(slots.awaitedLink, null);

  slots = applyChallengeLink(slots, waiting(), null, as('bob')).slots;
  const ended = applyChallengeLink(slots, closed(), 'The challenge was cancelled.', as('bob'));
  assert.equal(ended.slots.awaitedLink, null);
  assert.equal(ended.notice, 'The challenge was cancelled.');
});

test('only a link this account was holding is worth a line in the lobby', () => {
  const own = applyChallengeLink(emptyChallengeLinkSlots, open(), null, as('alice')).slots;
  assert.equal(
    applyChallengeLink(own, closed(), 'The challenge link expired.', as('alice')).notice,
    'The challenge link expired.',
  );
  // Cancelled by its own author: no reason comes back, and none is shown.
  assert.equal(applyChallengeLink(own, closed(), '', as('alice')).notice, null);
  // Somebody else's link closing is nothing to this account's lobby.
  assert.equal(
    applyChallengeLink(emptyChallengeLinkSlots, closed(), 'The challenge link expired.', as('cleo'))
      .notice,
    null,
  );
});

test('the page follows the link in its address, and only that one', () => {
  const viewing: ChallengeLinkSlots = {
    ...emptyChallengeLinkSlots,
    viewedLink: { code: 'k7Q2xP9mAb', link: null, message: null, asking: true },
  };
  const refused = applyChallengeLink(
    viewing,
    open(),
    'that game is ranked; sign in to accept it',
    as('cleo'),
  ).slots;
  assert.equal(refused.viewedLink?.link?.state, 'open');
  assert.equal(refused.viewedLink?.message, 'that game is ranked; sign in to accept it');
  assert.equal(refused.viewedLink?.asking, false, 'an answer ends the asking');

  const other = applyChallengeLink(refused, open({ code: 'other' }), null, as('cleo')).slots;
  assert.equal(other.viewedLink?.link?.code, 'k7Q2xP9mAb', 'another link must not replace it');

  const later = applyChallengeLink(refused, started(), null, as('cleo')).slots;
  assert.equal(later.viewedLink?.link?.gameId, 'game-1');
  assert.equal(later.viewedLink?.message, null, 'a refusal does not outlive the next answer');
});

test('connecting restores what the server holds and notices a link that went missing', () => {
  const held = applyChallengeLink(emptyChallengeLinkSlots, open(), null, as('alice')).slots;
  const kept = challengeLinksOnConnect(held, [open()], 'alice');
  assert.equal(kept.slots.ownLink?.code, 'k7Q2xP9mAb');
  assert.equal(kept.lost, false);

  const gone = challengeLinksOnConnect(held, undefined, 'alice');
  assert.equal(gone.slots.ownLink, null);
  assert.equal(gone.lost, true);

  const waitingAgain = challengeLinksOnConnect(emptyChallengeLinkSlots, [waiting()], 'bob');
  assert.equal(waitingAgain.slots.awaitedLink?.taker?.userId, 'bob');
  assert.equal(waitingAgain.lost, false);
});

test('an open link counts down in minutes', () => {
  assert.equal(linkExpiryLabel(NOW + 3_600_000, NOW), '60 min left');
  // Read against a clock up to half a minute stale, a fresh link is still an hour.
  assert.equal(linkExpiryLabel(NOW + 3_600_000, NOW - 25_000), '60 min left');
  assert.equal(linkExpiryLabel(NOW + 61_000, NOW), '1 min left');
  assert.equal(linkExpiryLabel(NOW + 100_000, NOW), '2 min left');
  assert.equal(linkExpiryLabel(NOW + 5_000, NOW), '1 min left');
  assert.equal(linkExpiryLabel(NOW - 1, NOW), 'Expired');
  assert.equal(linkExpiryLabel(undefined, NOW), '');
});

test('each side of a link is told what it needs to know', () => {
  assert.equal(linkStatusLine(open(), 'author', NOW), 'Open · 60 min left');
  assert.equal(linkStatusLine(waiting(), 'author', NOW), 'Bob is waiting for you');
  assert.equal(linkStatusLine(waiting(), 'taker', NOW), 'Offline · notified');
  assert.equal(linkTitle(open(), 'author'), 'Your challenge link');
  assert.equal(linkTitle(waiting(), 'author'), 'Bob took your link');
  assert.equal(linkTitle(waiting(), 'taker'), 'Waiting for Alice');
  assert.equal(linkTitle(open(), 'viewer'), "Alice's challenge");
});

test('whether anybody is coming is the thing a waiting taker is told', () => {
  assert.equal(authorWhereabouts('away', true), 'Offline · notified');
  assert.equal(authorWhereabouts('away', false), 'Offline');
  assert.equal(authorWhereabouts('idle', true), 'Away · notified');
  assert.equal(authorWhereabouts('busy', false), 'In another game');
  assert.equal(authorWhereabouts(undefined, false), '');
});

test('a refusal reads as a sentence', () => {
  assert.equal(asSentence('finish your current game first'), 'Finish your current game first.');
  assert.equal(asSentence('This challenge link has expired.'), 'This challenge link has expired.');
  assert.equal(asSentence('  '), '');
});
