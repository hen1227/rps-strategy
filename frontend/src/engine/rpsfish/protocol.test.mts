import assert from 'node:assert/strict';
import test from 'node:test';

import {
  RPSFISH_TOURNAMENT_NOTICE,
  engineSupportsMode,
  engineUnavailableMessage,
} from './protocol.ts';
import { encodeEnginePosition } from './session.ts';

test('the public engine keeps V6 behind the tournament lock', () => {
  assert.equal(engineSupportsMode('V5'), true);
  assert.equal(engineSupportsMode('V3'), true);
  assert.equal(engineSupportsMode('V6'), false);
  assert.equal(engineUnavailableMessage('V6'), RPSFISH_TOURNAMENT_NOTICE);

  assert.throws(
    () =>
      encodeEnginePosition({
        currentTurn: 'Red',
        grid: [],
        modeId: 'V6',
        moveNumber: 0,
      }),
    { message: RPSFISH_TOURNAMENT_NOTICE },
  );
});
