import assert from 'node:assert/strict';
import test from 'node:test';

import { canOfferAlerts, pushCapabilityFrom, urlBase64ToUint8Array } from './push.ts';

// Importing this module in Node at all is the assertion that matters most: it
// touches `Notification`, `serviceWorker` and `PushManager`, and if any of that
// ran at module scope the static export would ship empty pages.

const VAPID_PUBLIC_KEY =
  'BFqM2LoM_pwJm9-vxM3B8yDmOx00DyoqWra9ALpHmaLTmQ2ylE7SV239BeZNHCqI-jCJ05B7CLrQcV-gGswN8fo';

test('a VAPID key decodes to an uncompressed P-256 point', () => {
  const bytes = urlBase64ToUint8Array(VAPID_PUBLIC_KEY);
  assert.equal(bytes.length, 65);
  assert.equal(bytes[0], 0x04);
});

test('base64url padding and alphabet are both handled', () => {
  // A VAPID key is sent unpadded, and `atob` refuses an unpadded string.
  assert.deepEqual(Array.from(urlBase64ToUint8Array('AA')), [0]);
  assert.deepEqual(Array.from(urlBase64ToUint8Array('AAA')), [0, 0]);
  // '-' and '_' stand in for '+' and '/'.
  assert.deepEqual(
    Array.from(urlBase64ToUint8Array('-_8')),
    Array.from(urlBase64ToUint8Array('+/8')),
  );
});

test('desktop browsers are ready, and missing APIs are unsupported', () => {
  assert.equal(
    pushCapabilityFrom({
      hasServiceWorker: true,
      hasPushManager: true,
      isIOS: false,
      isStandalone: false,
    }),
    'ready',
  );
  assert.equal(
    pushCapabilityFrom({
      hasServiceWorker: false,
      hasPushManager: true,
      isIOS: false,
      isStandalone: false,
    }),
    'unsupported',
  );
  assert.equal(
    pushCapabilityFrom({
      hasServiceWorker: true,
      hasPushManager: false,
      isIOS: false,
      isStandalone: false,
    }),
    'unsupported',
  );
});

// Safari delivers push only to an installed site, so an iPhone in a tab has to
// be told that rather than offered a button that does nothing.
test('iOS needs the site on the Home Screen first', () => {
  assert.equal(
    pushCapabilityFrom({
      hasServiceWorker: true,
      hasPushManager: true,
      isIOS: true,
      isStandalone: false,
    }),
    'needs-home-screen',
  );
  assert.equal(
    pushCapabilityFrom({
      hasServiceWorker: true,
      hasPushManager: true,
      isIOS: true,
      isStandalone: true,
    }),
    'ready',
  );
});

test('the alerts offer is made once, and not when it would be a lie', () => {
  const now = 1_800_000_000_000;
  assert.equal(canOfferAlerts('unasked', 0, true, now), true);
  // Already on: nothing to offer.
  assert.equal(canOfferAlerts('granted', 0, true, now), false);
  // A denied browser resolves requestPermission without showing anything, so a
  // button would do nothing at all.
  assert.equal(canOfferAlerts('denied', 0, true, now), false);
  assert.equal(canOfferAlerts('needs-home-screen', 0, true, now), false);
  assert.equal(canOfferAlerts('unsupported', 0, true, now), false);
  // The server has no keys, so no amount of clicking would help.
  assert.equal(canOfferAlerts('unasked', 0, false, now), false);
  // Dismissed a week ago is still dismissed.
  assert.equal(canOfferAlerts('unasked', now + 1000, true, now), false);
  assert.equal(canOfferAlerts('unasked', now - 1000, true, now), true);
});
