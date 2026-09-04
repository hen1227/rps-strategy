import assert from 'node:assert/strict';
import test from 'node:test';

import { noticeRemaining, standingNotice } from './noticeSelectors.ts';
import type { ServerNotice } from '../types/protocol.ts';

const NOW = 1_800_000_000_000;

const announcement = (over: Partial<ServerNotice> = {}): ServerNotice => ({
  id: 'notice-1',
  text: 'Back in a minute.',
  tone: 'notice',
  postedAtUnixMs: NOW,
  expiresAtUnixMs: NOW + 15 * 60_000,
  ...over,
});

test('a notice lapses on the clock, with no message to say so', () => {
  // The server checks expiry on read and never announces an absence, so a
  // client holding the last broadcast has to make the same check itself.
  assert.ok(standingNotice(announcement(), NOW));
  assert.equal(standingNotice(announcement(), NOW + 15 * 60_000 + 1), null);
});

test('nothing posted is nothing standing', () => {
  assert.equal(standingNotice(null, NOW), null);
  assert.equal(standingNotice(undefined, NOW), null);
  // Empty text is how a cleared notice arrives on the wire.
  assert.equal(standingNotice(announcement({ text: '' }), NOW), null);
});

test('a notice with no deadline is treated as standing, not as expired', () => {
  // Only an older server would send one. Reading a missing deadline as
  // "expired" would hide a live notice, which is the failure this guards.
  const notice = announcement({ expiresAtUnixMs: 0 });
  assert.equal(standingNotice(notice, NOW)?.id, 'notice-1');
  assert.match(noticeRemaining(notice, NOW), /until you take it down/);
});

test('the countdown rounds up, so a live notice never reads as finished', () => {
  // "0 minutes left" on something still in front of every player is the one
  // answer that would mislead a host deciding whether to take it down.
  assert.match(noticeRemaining(announcement({ expiresAtUnixMs: NOW + 5_000 }), NOW), /under a minute/);
  assert.match(noticeRemaining(announcement({ expiresAtUnixMs: NOW + 61_000 }), NOW), /2 minutes/);
  assert.match(noticeRemaining(announcement({ expiresAtUnixMs: NOW + 45 * 60_000 }), NOW), /45 minutes/);
  assert.match(noticeRemaining(announcement({ expiresAtUnixMs: NOW + 3_600_000 }), NOW), /about an hour/);
  assert.match(noticeRemaining(announcement({ expiresAtUnixMs: NOW + 5 * 3_600_000 }), NOW), /about 5 hours/);
});
