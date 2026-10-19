// The licences page's data: every third-party package that ships in the website
// or either app, with its licence text. Writes src/features/credits/licenceData.json.
//
// usage:
//   npm run licences
//
// Run it after adding, removing or upgrading a dependency. The test beside the
// JSON fails until you do.
//
// What ships is measured rather than read off package.json, which lists build
// tools beside runtime code and says nothing about what those pull in:
//
// - JavaScript comes from the source maps of a real `expo export` of each
//   platform. A package is listed if the bundle holds code from it.
// - Native code comes from Expo's autolinking, which is what decides what
//   CocoaPods and Gradle link, minus modules that only link into debug builds.
// - React Native's prebuilt C++ dependencies and Hermes come from
//   scripts/licences-native.json, because nothing installed describes them.
//   The note at its top says where its texts came from.
// - The Android app's Maven libraries come from scripts/licences-android.json,
//   which scripts/licencesAndroid.mts measures from Gradle. It needs an Android
//   prebuild, so it is run apart from this, when an Android dependency moves.
//
// The exports go to a temporary directory, never to dist/, which is the build
// that gets deployed.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { LicenceEntry, LicencesData, Platform } from '../src/features/credits/licences.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repository = path.resolve(root, '..');
const output = path.join(root, 'src/features/credits/licenceData.json');

// The BSD 3-Clause License after its copyright line, as SPDX gives it, for the
// Android libraries whose POMs name the licence and ship no text.
const BSD_3_CLAUSE = `Redistribution and use in source and binary forms, with or without modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this list of conditions and the following disclaimer.

2. Redistributions in binary form must reproduce the above copyright notice, this list of conditions and the following disclaimer in the documentation and/or other materials provided with the distribution.

3. Neither the name of the copyright holder nor the names of its contributors may be used to endorse or promote products derived from this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.`;

const run = (command: string, args: string[]) =>
  execFileSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 1 << 28,
    stdio: ['ignore', 'pipe', 'inherit'],
  });

const readJSON = (file: string) => JSON.parse(fs.readFileSync(file, 'utf8'));

/** The directory of the package a bundled source file belongs to. */
function packageDirOf(source: string): string | null {
  const absolute = source.startsWith(root) ? source : path.join(root, source);
  const marker = `${path.sep}node_modules${path.sep}`;
  const at = absolute.lastIndexOf(marker);
  if (at < 0) return null;
  const rest = absolute.slice(at + marker.length).split(path.sep);
  const name = rest[0]!.startsWith('@') ? rest.slice(0, 2).join(path.sep) : rest[0]!;
  return absolute.slice(0, at + marker.length) + name;
}

/** Every package the exported bundle for one platform holds code from. */
function bundledPackages(platform: Platform, scratch: string): Set<string> {
  const outputDir = path.join(scratch, platform);
  console.log(`Exporting the ${platform} bundle…`);
  run('npx', ['expo', 'export', '--platform', platform, '--output-dir', outputDir, '--source-maps', 'external']);
  const dirs = new Set<string>();
  const maps = (fs.readdirSync(outputDir, { recursive: true }) as string[]).filter((file) => file.endsWith('.map'));
  if (maps.length === 0) throw new Error(`The ${platform} export wrote no source maps.`);
  for (const map of maps) {
    const { sources = [] } = readJSON(path.join(outputDir, map)) as { sources?: string[] };
    for (const source of sources) {
      const dir = packageDirOf(source);
      if (dir) dirs.add(dir);
    }
  }
  return dirs;
}

/** The nearest directory at or above `dir` that holds a package.json. */
function packageRoot(dir: string): string {
  let current = dir;
  while (!fs.existsSync(path.join(current, 'package.json'))) {
    const parent = path.dirname(current);
    if (parent === current) throw new Error(`No package.json above ${dir}`);
    current = parent;
  }
  return current;
}

/** Every package whose native code autolinking puts in a release build of one app. */
function linkedPackages(platform: 'android' | 'ios'): Set<string> {
  const dirs = new Set<string>();
  const expoModules = JSON.parse(
    run('npx', [
      'expo-modules-autolinking', 'resolve', '--platform', platform === 'ios' ? 'apple' : 'android', '--json',
    ]),
  ) as {
    modules: {
      debugOnly?: boolean;
      pods?: { podspecDir: string }[];
      projects?: { sourceDir: string }[];
    }[];
  };
  for (const module of expoModules.modules) {
    if (module.debugOnly) continue;
    for (const pod of module.pods ?? []) dirs.add(packageRoot(pod.podspecDir));
    for (const project of module.projects ?? []) dirs.add(packageRoot(project.sourceDir));
  }
  const community = JSON.parse(
    run('npx', ['expo-modules-autolinking', 'react-native-config', '--platform', platform, '--json']),
  ) as { dependencies: Record<string, { root: string }> };
  for (const dependency of Object.values(community.dependencies)) dirs.add(dependency.root);
  // React Native itself, which autolinking takes as given rather than listing.
  dirs.add(path.join(root, 'node_modules', 'react-native'));
  return dirs;
}

/** A package's licence and notice files, licence first, in a stable order. */
function licenceTexts(dir: string): string[] {
  const files = fs
    .readdirSync(dir)
    .filter((file) => /^(licen[cs]e|copying|notice)([-._].*)?$/i.test(file))
    .filter((file) => fs.statSync(path.join(dir, file)).isFile())
    .sort((a, b) => Number(/^notice/i.test(a)) - Number(/^notice/i.test(b)) || a.localeCompare(b));
  return files.map((file) => fs.readFileSync(path.join(dir, file), 'utf8').trim());
}

function repositoryURL(pkg: { repository?: string | { url?: string }; homepage?: string }): string | null {
  const raw = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url;
  if (raw) {
    const url = raw
      .replace(/^git\+/, '')
      .replace(/^git:\/\//, 'https://')
      .replace(/^ssh:\/\/git@github\.com\//, 'https://github.com/')
      .replace(/^git@github\.com:/, 'https://github.com/')
      .replace(/^github:/, 'https://github.com/')
      .replace(/\.git$/, '');
    if (/^https?:\/\//.test(url)) return url;
    if (/^[\w.-]+\/[\w.-]+$/.test(url)) return `https://github.com/${url}`;
  }
  return pkg.homepage && /^https?:\/\//.test(pkg.homepage) ? pkg.homepage.replace(/#.*$/, '') : null;
}

function authorOf(pkg: { author?: string | { name?: string } }): string | null {
  const author = typeof pkg.author === 'string' ? pkg.author : pkg.author?.name;
  // "Name <email> (url)" is npm's shorthand; the name is the part a notice needs.
  return author ? author.replace(/\s*[<(].*$/, '').trim() || null : null;
}

/**
 * React Native's repository moved from facebook/ to react/ on GitHub, and
 * packages published before the move still name the old address.
 */
const repositoryAliases: Record<string, string> = {
  'https://github.com/facebook/react-native': 'https://github.com/react/react-native',
};
const repositoryKey = (url: string | null) => (url ? (repositoryAliases[url] ?? url) : null);

function licenceOf(pkg: { license?: unknown; licenses?: unknown }): string {
  const declared = pkg.license ?? pkg.licenses;
  if (typeof declared === 'string') return declared;
  if (Array.isArray(declared)) return declared.map((entry) => entry?.type ?? String(entry)).join(' OR ');
  if (declared && typeof declared === 'object' && 'type' in declared) return String(declared.type);
  return 'UNKNOWN';
}

function main() {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'rps-licences-'));
  const shipped = new Map<string, Set<Platform>>();
  const add = (dir: string, platform: Platform) => {
    // The app's own code (the project root, and the local modules under it) is
    // not a third-party package.
    const relative = path.relative(root, dir);
    if (relative === '' || relative.startsWith('modules')) return;
    if (!shipped.has(dir)) shipped.set(dir, new Set());
    shipped.get(dir)!.add(platform);
  };
  try {
    for (const dir of bundledPackages('web', scratch)) add(dir, 'web');
    for (const dir of bundledPackages('ios', scratch)) add(dir, 'ios');
    for (const dir of bundledPackages('android', scratch)) add(dir, 'android');
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
  for (const dir of linkedPackages('ios')) add(dir, 'ios');
  for (const dir of linkedPackages('android')) add(dir, 'android');

  const texts: string[] = [];
  const textIndex = (text: string) => {
    const at = texts.indexOf(text);
    if (at >= 0) return at;
    texts.push(text);
    return texts.length - 1;
  };

  const packages: LicenceEntry[] = [];
  for (const [dir, platforms] of shipped) {
    const pkg = readJSON(path.join(dir, 'package.json'));
    packages.push({
      name: pkg.name,
      version: pkg.version ?? null,
      licence: licenceOf(pkg),
      platforms: [...platforms].sort(),
      url: repositoryURL(pkg),
      from: path.relative(root, dir).split(path.sep).join('/'),
      texts: licenceTexts(dir).map(textIndex),
      note: null,
      author: authorOf(pkg),
    });
  }

  // Some packages ship no licence file of their own. Most are published from a
  // monorepo whose one LICENSE covers every package in it, so such a package
  // takes the text of a package from the same repository that has one. What is
  // left declares MIT and names an author, and gets the MIT License with that
  // name, said to be exactly that on the page.
  // The package named after its repository carries its licence best: react-native
  // for React Native's repository, expo for Expo's.
  const byRepository = new Map<string, LicenceEntry>();
  for (const entry of packages) {
    const key = repositoryKey(entry.url);
    if (!key || entry.texts.length === 0) continue;
    const current = byRepository.get(key);
    if (!current || (entry.name === key.split('/').pop() && current.name !== entry.name)) byRepository.set(key, entry);
  }
  const mitPermission = fs
    .readFileSync(path.join(repository, 'LICENSES/MIT.txt'), 'utf8')
    .split('\n\n')
    .slice(2)
    .join('\n\n')
    .trim();
  for (const entry of packages) {
    if (entry.texts.length > 0) continue;
    const sibling = byRepository.get(repositoryKey(entry.url) ?? '');
    if (sibling && sibling.licence === entry.licence) {
      entry.texts = sibling.texts;
      entry.note = `Ships no licence file of its own. This is the licence of its repository, as ${sibling.name} carries it.`;
    } else if (entry.licence === 'MIT' && entry.author) {
      entry.texts = [textIndex(`MIT License\n\nCopyright (c) ${entry.author}\n\n${mitPermission}`)];
      entry.note = 'Ships no licence file. This is the MIT License it declares, with the name of its author.';
    }
  }
  for (const entry of packages) delete entry.author;

  const native = readJSON(path.join(root, 'scripts/licences-native.json')) as {
    reactNative: string;
    packages: { name: string; licence: string; url: string; platforms: Platform[]; text: string }[];
  };
  for (const entry of native.packages) {
    packages.push({
      name: entry.name,
      version: null,
      licence: entry.licence,
      platforms: entry.platforms,
      url: entry.url,
      from: null,
      texts: [textIndex(entry.text.trim())],
      note: null,
    });
  }

  // The Android app's Maven libraries. Their POMs name a licence and nothing
  // else, so the texts are built here: Apache's is the one Folly carries above,
  // copied from upstream, and MIT and BSD take the holder the POM names, said
  // to be exactly that on the page.
  const android = readJSON(path.join(root, 'scripts/licences-android.json')) as {
    reactNative: string;
    groups: {
      name: string;
      licence: string;
      declared: string | null;
      url: string | null;
      holder: string | null;
      artifacts: string[];
    }[];
  };
  const apache = native.packages.find((entry) => entry.licence === 'Apache-2.0')?.text.trim();
  if (!apache?.startsWith('Apache License')) throw new Error('No Apache-2.0 text in scripts/licences-native.json.');
  const textFor = (group: (typeof android.groups)[number]): { text: string; note: string | null } => {
    const holder = group.holder ? `Copyright (c) ${group.holder}` : null;
    switch (group.licence) {
      case 'Apache-2.0':
        return { text: apache, note: null };
      case 'MIT':
        if (!holder) break;
        return {
          text: `MIT License\n\n${holder}\n\n${mitPermission}`,
          note: 'Its POM declares the MIT License. This is that licence, with the holder the POM names.',
        };
      case 'BSD':
      case 'BSD-3-Clause':
        if (!holder) break;
        return {
          text: `${holder}\nAll rights reserved.\n\n${BSD_3_CLAUSE}`,
          note: group.licence === 'BSD'
            ? 'Its POM says only "BSD License". This is the three-clause BSD licence, with the holder the POM names.'
            : 'Its POM declares the BSD 3-Clause License. This is that licence, with the holder the POM names.',
        };
      case 'Android SDK License':
        return {
          text: 'Used under the Android Software Development Kit License Agreement:\nhttps://developer.android.com/studio/terms',
          note: "Google's own library, distributed under Google's terms rather than an open-source licence.",
        };
    }
    throw new Error(`No licence text for ${group.name} (${group.licence}). Add one to scripts/licences.mts.`);
  };
  for (const group of android.groups) {
    const { text, note } = textFor(group);
    const libraries = group.artifacts.length <= 6
      ? group.artifacts.join(', ')
      : `${group.artifacts.length} libraries`;
    packages.push({
      name: group.name,
      version: null,
      licence: group.licence,
      platforms: ['android'],
      url: group.url,
      from: null,
      texts: [textIndex(text)],
      note: [`Android: ${libraries}.`, note].filter(Boolean).join(' '),
    });
  }

  // The engine is this project's own, but it is a separate work under its own
  // licence, and the LGPL asks to travel with a copy of itself and of the GPL
  // it builds on.
  packages.push({
    name: 'RPSFish',
    version: null,
    licence: 'LGPL-3.0-or-later',
    platforms: ['android', 'ios', 'web'],
    url: 'https://github.com/hen1227/rpsfish',
    from: null,
    texts: [
      textIndex(fs.readFileSync(path.join(repository, 'LICENSES/LGPL-3.0-or-later.txt'), 'utf8').trim()),
      textIndex(fs.readFileSync(path.join(root, 'modules/rpsfish/COPYING'), 'utf8').trim()),
    ],
    note: 'The analysis engine. It is by the same author as the rest of RPS Strategy, but it is a separate program with its own repository and licence.',
  });

  // GitHub's mark, on the sidebar's link to this repository. It is one path
  // copied out of Octicons into src/ui/GitHubMark.tsx rather than a package,
  // so neither measurement above can see it, and the MIT still asks for its
  // notice to go with it. The text is Octicons' own LICENSE, which is this.
  packages.push({
    name: 'Octicons',
    version: null,
    licence: 'MIT',
    platforms: ['android', 'ios', 'web'],
    url: 'https://github.com/primer/octicons',
    from: null,
    texts: [textIndex(`MIT License\n\nCopyright (c) 2026 GitHub Inc.\n\n${mitPermission}`)],
    note: "Only GitHub's mark, on the button that links to this project's source. The mark itself is GitHub's trademark.",
  });

  packages.sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }));

  const listed = new Set(packages.map((entry) => entry.name));
  const direct = Object.keys(readJSON(path.join(root, 'package.json')).dependencies ?? {});
  const reactNative = readJSON(path.join(root, 'node_modules/react-native/package.json')).version as string;
  if (reactNative !== android.reactNative) {
    console.warn(
      `React Native is ${reactNative}, but scripts/licences-android.json was measured with ${android.reactNative}. ` +
        'Run `npm run licences:android` against a fresh prebuild.',
    );
  }
  if (reactNative !== native.reactNative) {
    console.warn(
      `React Native is ${reactNative}, but scripts/licences-native.json was written for ${native.reactNative}. ` +
        'Check its list of prebuilt dependencies still holds, then update its reactNative field.',
    );
  }

  const data: LicencesData = {
    about: 'Generated by scripts/licences.mts. Do not edit; run `npm run licences`.',
    reactNative,
    packages,
    texts,
    notShipped: direct.filter((name) => !listed.has(name)).sort(),
  };
  fs.writeFileSync(output, `${JSON.stringify(data, null, 1)}\n`);

  const count = (platform: Platform) => packages.filter((entry) => entry.platforms.includes(platform)).length;
  const missing = packages.filter((entry) => entry.texts.length === 0).map((entry) => entry.name);
  console.log(
    `Wrote ${path.relative(root, output)}: ${count('web')} on the web, ${count('ios')} on iOS, ` +
      `${count('android')} on Android, ${texts.length} distinct texts.`,
  );
  if (missing.length > 0) console.log(`No licence file ships with: ${missing.join(', ')}.`);
  console.log(`Direct dependencies that ship in neither build: ${data.notShipped.join(', ') || 'none'}.`);
}

main();
