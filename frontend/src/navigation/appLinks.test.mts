import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { ACCOUNT_CALLBACK_PATH } from '../store/signInReturn.ts';

// Which website addresses a phone hands to the app is written down twice: once
// for iOS, in the site's apple-app-site-association, and once for Android, as
// intent filters in app.json. Neither can be generated from the routes, and
// neither fails loudly — a page left off opens in the browser, and a claimed
// sign-in return carries a browser sign-in into the app halfway through. So
// these tests hold both lists to the route tree.

const HERE = dirname(fileURLToPath(import.meta.url));
const FRONTEND = resolve(HERE, '../..');
const APP_DIR = join(FRONTEND, 'src/app');

const readJson = (path: string) => JSON.parse(readFileSync(join(FRONTEND, path), 'utf8'));
const expo = readJson('app.json').expo;
const aasa = readJson('public/.well-known/apple-app-site-association');
const assetLinks = readJson('public/.well-known/assetlinks.json');

type Component = { '/': string; exclude?: boolean };
const details: { appIDs: string[]; components: Component[] }[] = aasa.applinks.details;
const components = details.flatMap((detail) => detail.components);
const iosClaimed = components.filter((c) => !c.exclude).map((c) => c['/']);
const iosExcluded = components.filter((c) => c.exclude).map((c) => c['/']);

type Data = { scheme?: string; host?: string; path?: string; pathPrefix?: string; pathPattern?: string };
const httpsFilters = (expo.android.intentFilters as { autoVerify?: boolean; data: Data[] }[]).filter((filter) =>
  filter.data.some((data) => data.scheme === 'https'),
);
const androidData = httpsFilters.flatMap((filter) => filter.data);

const siteHost = new URL(expo.extra.router.origin).host;

/** Every page's address, from the files under src/app: groups dropped, index folded into its folder. */
const routePaths = (): string[] => {
  const paths: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.name.endsWith('.tsx')) continue;
      const name = entry.name.replace(/\.tsx$/, '');
      if (name === '_layout' || name.startsWith('+')) continue;
      const segments = relative(APP_DIR, join(dir, name))
        .split('/')
        .filter((segment) => !/^\(.*\)$/.test(segment) && segment !== 'index');
      paths.push(`/${segments.join('/')}`);
    }
  };
  walk(APP_DIR);
  return paths.sort();
};

test('every page is claimed on both platforms, except the sign-in return', () => {
  const expected = routePaths().filter((path) => path !== ACCOUNT_CALLBACK_PATH);
  assert.deepEqual([...iosClaimed].sort(), expected, 'apple-app-site-association');
  assert.deepEqual(androidData.map((data) => data.path).sort(), expected, 'app.json intentFilters');
});

test('the sign-in return stays in the browser', () => {
  assert.ok(routePaths().includes(ACCOUNT_CALLBACK_PATH), 'the callback page moved; update these files');
  assert.ok(iosExcluded.includes(ACCOUNT_CALLBACK_PATH));
  // Android has no exclusions, so the only safe claims are exact ones: a
  // prefix or pattern could reach the callback without naming it.
  for (const data of androidData) {
    assert.equal(data.pathPrefix, undefined);
    assert.equal(data.pathPattern, undefined);
  }
});

test('both platforms claim the site the router serves, for this app', () => {
  assert.deepEqual(expo.ios.associatedDomains, [`applinks:${siteHost}`]);
  assert.ok(httpsFilters.length > 0);
  for (const filter of httpsFilters) assert.equal(filter.autoVerify, true);
  for (const data of androidData) assert.equal(data.host, siteHost);

  for (const detail of details) {
    for (const appID of detail.appIDs) {
      assert.equal(appID.slice(appID.indexOf('.') + 1), expo.ios.bundleIdentifier);
    }
  }
  assert.equal(assetLinks[0].target.package_name, expo.android.package);
});
