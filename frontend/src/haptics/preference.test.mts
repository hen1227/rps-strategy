import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { deviceStorage } from '@/store/deviceStorage';

// Seeded before the store is loaded, because it reads the device once, at
// module load, the way it does when the app starts.
deviceStorage()?.setItem('rps.vibration.v1', 'off');
const { setHaptics, setVibration, switchFromStored, useFeelStore } = await import(
  './preference.ts'
);

describe('the haptics switches', () => {
  it('are on until somebody turns them off', () => {
    assert.equal(switchFromStored(null), true);
    assert.equal(switchFromStored('on'), true);
    assert.equal(switchFromStored('off'), false);
    // A value this build never wrote is not a reason to go quiet.
    assert.equal(switchFromStored('loud'), true);
  });

  it('start from what this device chose last time', () => {
    assert.equal(useFeelStore.getState().haptics, true);
    assert.equal(useFeelStore.getState().vibration, false);
  });

  it('remember a change on the device', () => {
    setHaptics(false);
    setVibration(true);
    assert.equal(deviceStorage()?.getItem('rps.haptics.v1'), 'off');
    assert.equal(deviceStorage()?.getItem('rps.vibration.v1'), 'on');
    assert.deepEqual(useFeelStore.getState(), { haptics: false, vibration: true });
  });
});
