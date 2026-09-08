import assert from 'node:assert/strict';
import test from 'node:test';

import { activeRestriction, restrictionNotice } from './moderationSelectors.ts';
import type { Restriction } from '../types/protocol.ts';

const NOW = 1_800_000_000_000;

const mute = (overrides: Partial<Restriction> = {}): Restriction => ({
  kind: 'mute',
  reason: 'spamming the lobby',
  ...overrides,
});

test('a restriction with no deadline is always in force', () => {
  const restrictions = [mute({ expiresAtUnixMs: undefined })];
  assert.ok(activeRestriction(restrictions, 'mute', NOW));
});

test('a restriction lapses on its own, without anything having to run', () => {
  // The whole expiry model: the client is handed a deadline and checks it. A
  // mute placed for an hour has to stop applying while somebody sits on the
  // same page, which is why this is a function of `now` at all.
  const restrictions = [mute({ expiresAtUnixMs: NOW + 60_000 })];
  assert.ok(activeRestriction(restrictions, 'mute', NOW), 'should apply before the deadline');
  assert.equal(
    activeRestriction(restrictions, 'mute', NOW + 60_001),
    null,
    'should have lapsed after it',
  );
});

test('kinds do not bleed into each other', () => {
  // A ranked bar must not disable the chat box. The three sanctions are
  // independent, which is the point of having three.
  const restrictions = [{ kind: 'ranked' as const, reason: 'sandbagging' }];
  assert.equal(activeRestriction(restrictions, 'mute', NOW), null);
  assert.ok(activeRestriction(restrictions, 'ranked', NOW));
});

test('the notice says both what is left and why', () => {
  // Either half alone produces the message that generates a complaint rather
  // than answering it.
  const notice = restrictionNotice(
    mute({ expiresAtUnixMs: NOW + 20 * 60_000 }),
    'chat',
    NOW,
  );
  assert.match(notice, /20 minutes/);
  assert.match(notice, /spamming the lobby/);
});

test('an indefinite restriction states no deadline rather than a wrong one', () => {
  const notice = restrictionNotice(mute({ expiresAtUnixMs: undefined }), 'chat', NOW);
  assert.equal(notice, 'You cannot chat: spamming the lobby.');
});

test('a restriction with no reason recorded still reads as a sentence', () => {
  const notice = restrictionNotice(
    { kind: 'mute', expiresAtUnixMs: NOW + 3 * 3_600_000 },
    'chat',
    NOW,
  );
  assert.equal(notice, 'You cannot chat for another 3 hours.');
});

test('the countdown is coarse, in the units somebody reads it in', () => {
  const at = (ms: number) =>
    restrictionNotice({ kind: 'mute', expiresAtUnixMs: NOW + ms }, 'chat', NOW);
  assert.match(at(30_000), /under a minute/);
  assert.match(at(45 * 60_000), /45 minutes/);
  assert.match(at(3_600_000), /an hour/);
  assert.match(at(5 * 86_400_000), /5 days/);
});
