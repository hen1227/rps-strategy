import assert from 'node:assert/strict';
import test from 'node:test';

// Importing the *native* half in Node is the assertion that matters most, for
// the reason discordAuth.test.mts gives — and more so here, because loading
// `expo-apple-authentication` registers a native view, which throws in any
// binary built without it. Were the package reached at module scope, this line
// would throw, and so would every phone build made before it was added.
import { APPLE_PROVIDER, isAppleSignInAvailable, signInThroughApple } from './appleAuth.ts';
import { signInRefusalMessage } from './signInReturn.ts';

test('the native half reports no Apple module under the test loader', () => {
  // The loader answers `requireOptionalNativeModule` with null, which is what
  // Android and a binary built before the module was added both answer.
  assert.equal(isAppleSignInAvailable(), false);
});

test('the phone asks the server for its own flow, not the website one', () => {
  assert.equal(APPLE_PROVIDER, 'apple');
});

test('a sign-in that could not start fails with words rather than throwing', async () => {
  // Under Node the package is not there to load, which stands in for every
  // way the start can fail. The button waiting on this must get an answer.
  const outcome = await signInThroughApple({
    nonce: async () => 'nonce',
    authorize: async () => 'https://appleid.apple.com/auth/authorize',
  });
  assert.equal(outcome.kind, 'failed');
});

test("Apple's refusals have words too", () => {
  assert.match(signInRefusalMessage('user_cancelled_authorize'), /cancelled/i);
  assert.match(signInRefusalMessage('apple_unavailable'), /Apple/);
  assert.doesNotMatch(signInRefusalMessage('apple_unavailable'), /Discord/);
});
