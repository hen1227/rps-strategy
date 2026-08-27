// The only part of the picker a test without a DOM can reach.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { dataURLPayload } from '@/features/lab/pickImage.types';

test('a data URL gives up its payload, and anything else gives up nothing', () => {
  assert.equal(dataURLPayload('data:image/png;base64,AAAB'), 'AAAB');
  assert.equal(dataURLPayload('data:image/jpeg;charset=utf-8;base64,QUJD'), 'QUJD');

  for (const wrong of [
    'data:image/png;base64,', // nothing after the comma
    'data:image/png,rawbytes', // not base64
    'data:image/png;base64', // no comma at all
    'https://example.com/a.png', // not a data URL
    '',
  ]) {
    assert.equal(dataURLPayload(wrong), null, wrong);
  }
});
