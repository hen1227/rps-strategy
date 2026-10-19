// The phone's halves of Apple's and Discord's sign-ins, for the end-to-end
// sign-in test: Apple's sheet, the system browser, and the app's own address.
//
// Registered on top of `scripts/loader.mjs`, which already answers React
// Native, Expo and the device store. These three are the packages
// `appleAuth.ts` and `discordAuth.ts` reach for inside a function, and what
// each one does on a phone — show a sheet, open a browser — the test does
// instead, through the hooks it puts on `globalThis.__signInE2E`. Everything
// either side of them is the app's real code.

const STUBS = {
  'expo-apple-authentication': `
    export const signInAsync = (options) => globalThis.__signInE2E.appleSheet(options);
    export const isAvailableAsync = async () => true;
  `,
  'expo-web-browser': `
    export const openAuthSessionAsync = (url, redirectUrl) =>
      globalThis.__signInE2E.browser(url, redirectUrl);
    export const maybeCompleteAuthSession = () => ({ type: 'failed' });
  `,
  // Three slashes, exactly as the real one makes the native return address:
  // see signInReturn.ts and the Discord return-URL allowlist.
  'expo-linking': `
    export const createURL = (path) => 'rps-strategy://' + (path.startsWith('/') ? path : '/' + path);
  `,
};

const PREFIX = 'signin-e2e:';

export const resolve = async (specifier, context, next) =>
  specifier in STUBS ? { shortCircuit: true, url: PREFIX + specifier } : next(specifier, context);

export const load = async (url, context, next) =>
  url.startsWith(PREFIX)
    ? { format: 'module', shortCircuit: true, source: STUBS[url.slice(PREFIX.length)] }
    : next(url, context);
