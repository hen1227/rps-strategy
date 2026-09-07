import assert from 'node:assert/strict';
import test from 'node:test';

import { engineSupportsMode, engineUnavailableMessage } from './protocol.ts';
import { encodeEnginePosition } from './session.ts';

test('the public engine no longer locks V6 behind the tournament', () => {
  assert.equal(engineSupportsMode('V5'), true);
  assert.equal(engineSupportsMode('V3'), true);
  assert.equal(engineSupportsMode('V6'), true);
  assert.equal(engineUnavailableMessage('V6'), null);

  assert.doesNotThrow(() =>
    encodeEnginePosition({
      currentTurn: 'Red',
      grid: [],
      modeId: 'V6',
      moveNumber: 0,
    }),
  );
});
