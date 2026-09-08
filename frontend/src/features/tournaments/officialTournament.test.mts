import assert from 'node:assert/strict';
import test from 'node:test';

import {
  officialTournament,
  officialTournamentPhase,
  officialTournamentPromoVisible,
  untilLabel,
} from './officialTournament.ts';

// September 2026 is EDT, so Eastern is UTC-4. Every instant below is written in
// Eastern and converted here, which is the same reading the module's own
// comment argues for — and the point of the conversion being in the test is
// that it fails if somebody edits the constants into EST by hand.
const eastern = (day: number, hour: number, minute = 0) =>
  Date.UTC(2026, 8, day, hour + 4, minute);

test('the event is at noon Eastern on the fifth', () => {
  assert.equal(officialTournament.startsAtUnixMs, eastern(5, 12));
});

test('the phase follows the afternoon', () => {
  assert.equal(officialTournamentPhase(eastern(5, 11, 59)), 'upcoming');
  assert.equal(officialTournamentPhase(eastern(5, 12)), 'live');
  assert.equal(officialTournamentPhase(eastern(5, 15)), 'live');
  assert.equal(officialTournamentPhase(eastern(5, 18)), 'over');
  assert.equal(officialTournamentPhase(eastern(6, 12)), 'over');
});

// The whole reason the promo is a window rather than a component somebody
// deletes afterwards: a banner about an event that finished last month makes a
// live site look abandoned, and nobody remembers to take it down.
test('the promo runs for the two days around it and then stops', () => {
  assert.equal(officialTournamentPromoVisible(eastern(3, 23, 59)), false);
  assert.equal(officialTournamentPromoVisible(eastern(4, 0)), true);
  assert.equal(officialTournamentPromoVisible(eastern(4, 12)), true);
  assert.equal(officialTournamentPromoVisible(eastern(5, 23, 59)), true);
  assert.equal(officialTournamentPromoVisible(eastern(6, 0)), false);
  assert.equal(officialTournamentPromoVisible(eastern(30, 12)), false);
});

// The engines are stood down from half an hour before the first round until
// well after the last. The server owns the real schedule — this is the sentence
// the page prints — so the two are asserted to describe the same window.
test('the stated bot window brackets the event', () => {
  assert.equal(officialTournament.botsOfflineFromUnixMs, eastern(5, 11, 30));
  assert.equal(officialTournament.botsOfflineUntilUnixMs, eastern(5, 18));
  assert.ok(officialTournament.botsOfflineFromUnixMs < officialTournament.startsAtUnixMs);
  assert.ok(officialTournament.botsOfflineUntilUnixMs >= officialTournament.endsAtUnixMs);
});

test('the countdown is coarse and reads as English', () => {
  const start = officialTournament.startsAtUnixMs;
  assert.equal(untilLabel(start, start), 'starting now');
  assert.equal(untilLabel(start + 60_000, start), 'starting now');
  assert.equal(untilLabel(start - 60_000, start), 'in 1 minute');
  assert.equal(untilLabel(start - 25 * 60_000, start), 'in 25 minutes');
  assert.equal(untilLabel(start - 3 * 3_600_000, start), 'in 3 hours');
  assert.equal(untilLabel(start - 26 * 3_600_000, start), 'in 1 day');
});
