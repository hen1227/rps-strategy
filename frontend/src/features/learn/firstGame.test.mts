import assert from 'node:assert/strict';
import test from 'node:test';

import { deviceStorage } from '@/store/deviceStorage';
import { firstGameDue, takeFirstGameOffer } from './firstGame.ts';

test('the lessons open by themselves only for a new device that can remember it', () => {
  assert.equal(firstGameDue({ newDevice: true, alreadyOffered: false, canRemember: true }), true);
  // Somebody who has been here before learned the game already.
  assert.equal(firstGameDue({ newDevice: false, alreadyOffered: false, canRemember: true }), false);
  assert.equal(firstGameDue({ newDevice: true, alreadyOffered: true, canRemember: true }), false);
  // Blocked storage looks like a new device on every visit.
  assert.equal(firstGameDue({ newDevice: true, alreadyOffered: false, canRemember: false }), false);
});

test('a new device is offered the lessons once, and the offer is written down', () => {
  // Under Node the device store is an empty in-memory map, so this process is
  // a device that has never been here: its account id is minted on first ask.
  assert.equal(takeFirstGameOffer(), true);
  assert.equal(takeFirstGameOffer(), false, 'not twice in one launch');
  assert.ok(deviceStorage()?.getItem('rps.firstGameOffered.v1'), 'and not on the next launch');
});
