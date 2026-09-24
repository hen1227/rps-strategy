import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { entriesFor, licenceCounts } from './licences.ts';
import type { LicencesData } from './licences.ts';

// The licences page lists what the builds ship, measured by `npm run licences`
// from real exports. Those take a minute, so this suite doesn't redo them; it
// checks that nothing the measurement rested on has moved since. A dependency
// added, dropped or upgraded without regenerating fails here, and the fix is
// always the same command.

const HERE = dirname(fileURLToPath(import.meta.url));
const FRONTEND = resolve(HERE, '../../..');
const readJSON = (path: string) => JSON.parse(readFileSync(resolve(FRONTEND, path), 'utf8'));
const data = readJSON('src/features/credits/licences.json') as LicencesData;
const REGENERATE = 'Run `npm run licences` to regenerate the licences page.';

test('every package on the licences page is the version installed', () => {
  for (const entry of data.packages) {
    if (!entry.from) continue;
    const installed = readJSON(`${entry.from}/package.json`).version;
    strictEqual(installed, entry.version, `${entry.name} is ${installed}, but the page lists ${entry.version}. ${REGENERATE}`);
  }
});

test('every dependency is on the licences page or known not to ship', () => {
  const listed = new Set([...data.packages.map((entry) => entry.name), ...data.notShipped]);
  for (const name of Object.keys(readJSON('package.json').dependencies ?? {})) {
    ok(listed.has(name), `${name} is a dependency the licences page has never looked at. ${REGENERATE}`);
  }
});

test("React Native hasn't moved since its native dependencies were listed", () => {
  const installed = readJSON('node_modules/react-native/package.json').version;
  const native = readJSON('scripts/licences-native.json').reactNative;
  strictEqual(
    native,
    installed,
    `React Native is ${installed}. Check that scripts/licences-native.json still names its prebuilt dependencies, set its reactNative to match, then regenerate.`,
  );
  strictEqual(data.reactNative, installed, REGENERATE);
});

test('every package carries a licence text, and every text belongs to a package', () => {
  const used = new Set<number>();
  for (const entry of data.packages) {
    ok(entry.texts.length > 0, `${entry.name} has no licence text on the page.`);
    for (const index of entry.texts) {
      ok(typeof data.texts[index] === 'string' && data.texts[index].length > 0, `${entry.name} points at text ${index}.`);
      used.add(index);
    }
  }
  strictEqual(used.size, data.texts.length);
});

test('each build lists the engine, and the web never lists native-only code', () => {
  for (const platform of ['web', 'ios'] as const) {
    ok(entriesFor(data, platform).some((entry) => entry.name === 'RPSFish'), `RPSFish is missing from ${platform}.`);
  }
  const web = new Set(entriesFor(data, 'web').map((entry) => entry.name));
  for (const nativeOnly of ['react-native', 'Hermes', 'Folly']) ok(!web.has(nativeOnly), nativeOnly);
});

test('licence counts are most common first, and add up to the list', () => {
  const entries = entriesFor(data, 'ios');
  const counts = licenceCounts(entries);
  strictEqual(counts.reduce((sum, { count }) => sum + count, 0), entries.length);
  deepStrictEqual(
    counts.map(({ count }) => count),
    [...counts.map(({ count }) => count)].sort((a, b) => b - a),
  );
});
