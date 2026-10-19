import assert from 'node:assert/strict';
import test from 'node:test';

import {
  analyticsAllowed,
  consentPromptOwed,
  zoneRequiresOptIn,
  type AnalyticsConsentState,
} from './consent.ts';

const state = (patch: Partial<AnalyticsConsentState>): AnalyticsConsentState => ({
  choice: null,
  optInRequired: false,
  privacySignal: false,
  ...patch,
});

// The line the whole consent design rests on. Getting a European zone wrong is
// sending stats from somebody who was never asked; getting another zone wrong
// is only a prompt nobody needed.
test('Europe and its outermost regions are asked first', () => {
  for (const zone of [
    'Europe/Berlin',
    'Europe/London',
    'Europe/Dublin',
    'Europe/Zurich',
    'Atlantic/Canary',
    'Atlantic/Reykjavik',
    'Asia/Nicosia',
    'Indian/Reunion',
    'America/Martinique',
  ]) {
    assert.equal(zoneRequiresOptIn(zone), true, zone);
  }
});

test('elsewhere is counted by default', () => {
  for (const zone of ['America/New_York', 'America/Los_Angeles', 'Asia/Tokyo', 'Australia/Sydney']) {
    assert.equal(zoneRequiresOptIn(zone), false, zone);
  }
});

// A privacy-hardened browser reports UTC, and an engine with no zone reports
// nothing. Neither says where somebody is, so both are asked.
test('a zone that names nowhere is asked', () => {
  for (const zone of [undefined, null, '', 'UTC', 'GMT', 'Etc/UTC', 'Etc/GMT+2']) {
    assert.equal(zoneRequiresOptIn(zone), true, String(zone));
  }
});

test('nothing is sent from a device that has to be asked and has not answered', () => {
  assert.equal(analyticsAllowed(state({ optInRequired: true }), true), false);
  assert.equal(consentPromptOwed(state({ optInRequired: true }), true), true);
});

test('an answer is final either way', () => {
  assert.equal(analyticsAllowed(state({ optInRequired: true, choice: 'granted' }), true), true);
  assert.equal(analyticsAllowed(state({ choice: 'denied' }), true), false);
  assert.equal(consentPromptOwed(state({ optInRequired: true, choice: 'denied' }), true), false);
});

test('Global Privacy Control starts a device off, and a later yes overrides it', () => {
  assert.equal(analyticsAllowed(state({ privacySignal: true }), true), false);
  assert.equal(analyticsAllowed(state({ privacySignal: true, choice: 'granted' }), true), true);
  // Off by signal is not a question owed.
  assert.equal(consentPromptOwed(state({ privacySignal: true }), true), false);
});

test('a build with no measurement ID sends nothing and asks nothing', () => {
  assert.equal(analyticsAllowed(state({ choice: 'granted' }), false), false);
  assert.equal(consentPromptOwed(state({ optInRequired: true }), false), false);
});
