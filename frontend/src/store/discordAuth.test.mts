import assert from 'node:assert/strict';
import test from 'node:test';

import { discordRefusalMessage, ticketFromCallbackURL } from './discordAuth.types.ts';
// Importing the *native* half in Node is the assertion that matters most here.
// Node's loader knows nothing of Metro's `.web.ts`, so this is the file it
// resolves — and if `expo-web-browser` or `expo-linking` were reached at module
// scope rather than inside a function, this line would throw, and the static
// web export would be shipping a native module to every visitor.
import { isDiscordSignInAvailable } from './discordAuth.ts';

test('a ticket is read out of a web return address', () => {
  assert.deepEqual(
    ticketFromCallbackURL('https://rps.henhen1227.com/account/callback?ticket=rps_t_abc'),
    { ticket: 'rps_t_abc', error: null },
  );
});

test('a ticket is read out of a native return address', () => {
  // A custom scheme is not a "special" URL, which is why this is parsed by
  // hand rather than through `new URL`.
  assert.deepEqual(ticketFromCallbackURL('rps-strategy://account/callback?ticket=rps_t_abc'), {
    ticket: 'rps_t_abc',
    error: null,
  });
});

test('a refusal is read instead of a ticket', () => {
  assert.deepEqual(
    ticketFromCallbackURL('https://rps.henhen1227.com/account/callback?error=access_denied'),
    { ticket: null, error: 'access_denied' },
  );
});

test('an address with neither is not a failure to parse', () => {
  // The bare route, which is what a pre-rendered page loads as.
  assert.deepEqual(ticketFromCallbackURL('https://rps.henhen1227.com/account/callback'), {
    ticket: null,
    error: null,
  });
  assert.deepEqual(ticketFromCallbackURL('rps-strategy://account/callback?'), {
    ticket: null,
    error: null,
  });
});

test('other parameters and a fragment do not confuse it', () => {
  assert.deepEqual(
    ticketFromCallbackURL('https://rps.henhen1227.com/account/callback?from=lobby&ticket=abc#top'),
    { ticket: 'abc', error: null },
  );
});

test('a percent-encoded ticket comes back decoded', () => {
  assert.equal(ticketFromCallbackURL('rps-strategy://x?ticket=a%2Bb').ticket, 'a+b');
});

test('every refusal has words, including one nobody planned for', () => {
  assert.match(discordRefusalMessage('access_denied'), /cancelled/i);
  assert.match(discordRefusalMessage('expired'), /again/i);
  assert.notEqual(discordRefusalMessage('something_new'), '');
});

test('the native half reports no browser module under the test loader', () => {
  // The loader answers `requireOptionalNativeModule` with null, which is the
  // same answer a binary built before the module was added would give — so the
  // capability check is exercised, not merely imported.
  assert.equal(isDiscordSignInAvailable(), false);
});
