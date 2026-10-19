// The Android app's Maven libraries and their licences. Writes
// scripts/licences-android.json, which scripts/licences.mts merges into the
// licences page.
//
// usage:
//   npm run licences:android -- <a prebuilt android/ directory>
//
// The Android build ships libraries no npm package describes — AndroidX,
// Kotlin, OkHttp, Fresco, Firebase and Google Play services among them — so
// they are measured from Gradle, the way the iOS list is measured from
// autolinking: the release runtime classpath is what ships. Each library's
// licence is the one its POM declares. Gradle reads module metadata rather than
// POMs, so a POM it has not cached is fetched from the repository it came from.
//
// Run it after an Android dependency changes, from a prebuild somewhere other
// than this directory:
//   cp -cR frontend /tmp/fe && cd /tmp/fe && npx expo prebuild -p android --no-install
//   npm run licences:android -- /tmp/fe/android
// Gradle needs JAVA_HOME (JDK 17) and ANDROID_HOME, as for any Android build.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'scripts/licences-android.json');
const gradleCache = path.join(os.homedir(), '.gradle/caches/modules-2/files-2.1');
const repositories = ['https://dl.google.com/dl/android/maven2', 'https://repo1.maven.org/maven2'];

interface AndroidGroup {
  /** The Maven group, which is what the page lists a library under. */
  name: string;
  /** SPDX where the POM's words name one; the POM's own words otherwise. */
  licence: string;
  /** What the POM said, when it is not what `licence` says. */
  declared: string | null;
  url: string | null;
  /** Who the POM names as its organisation or developer, for a notice. */
  holder: string | null;
  artifacts: string[];
}

const SPDX: [RegExp, string][] = [
  [/apache/i, 'Apache-2.0'],
  [/^(the )?mit( license)?$/i, 'MIT'],
  [/^bsd-3-clause$/i, 'BSD-3-Clause'],
  [/^bsd( license)?$/i, 'BSD'],
  [/android software development kit license/i, 'Android SDK License'],
];
const spdxOf = (declared: string) => SPDX.find(([pattern]) => pattern.test(declared.trim()))?.[1] ?? declared.trim();

/**
 * Where a POM names the wrong holder, or none, for a notice. Checked by hand
 * against each project's own LICENSE.
 */
const CORRECTIONS: Record<string, Partial<Pick<AndroidGroup, 'name' | 'url' | 'holder'>>> = {
  // A copy of Protocol Buffers, published under AndroidX's group and POM.
  'androidx.datastore:datastore-preferences-external-protobuf': {
    name: 'Protocol Buffers',
    url: 'https://github.com/protocolbuffers/protobuf',
    holder: 'Google Inc.',
  },
  'com.facebook.infer.annotation:infer-annotation': { holder: 'Facebook, Inc. and its affiliates' },
};

/** AndroidX is one project in sixty Maven groups, and one row on the page. */
const ANDROIDX = { name: 'AndroidX', url: 'https://developer.android.com/jetpack/androidx' };

/** The release runtime classpath, as group:artifact:version. */
function shippedCoordinates(androidDir: string): string[] {
  const report = execFileSync(
    './gradlew',
    [':app:dependencies', '--configuration', 'releaseRuntimeClasspath', '-q', '--console=plain'],
    { cwd: androidDir, encoding: 'utf8', maxBuffer: 1 << 26 },
  );
  const found = new Map<string, string>();
  for (const line of report.split('\n')) {
    const match = /(?:\+|\\)--- (?!project )([\w.-]+):([\w.-]+)(?::([^\s]+))?(?: -> ([\w.-]+))?(?: \([*cn]\))?\s*$/.exec(line);
    if (!match) continue;
    const [, group, artifact, requested, resolved] = match;
    found.set(`${group}:${artifact}`, resolved ?? requested ?? '');
  }
  return [...found].map(([key, version]) => `${key}:${version}`).sort();
}

/**
 * The Maven coordinates that are npm packages, which the page already lists by
 * their package name: every Expo module's own publication, and React Native's.
 */
function npmCoordinates(): Set<string> {
  const resolved = JSON.parse(
    execFileSync('npx', ['expo-modules-autolinking', 'resolve', '--platform', 'android', '--json'], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 1 << 26,
    }),
  ) as { modules: { projects?: { publication?: { groupId: string; artifactId: string } }[] }[] };
  const coordinates = new Set(['com.facebook.react:react-android', 'com.facebook.react:hermes-android']);
  for (const module of resolved.modules) {
    for (const project of module.projects ?? []) {
      if (project.publication) {
        coordinates.add(`${project.publication.groupId}:${project.publication.artifactId}`);
      }
    }
  }
  return coordinates;
}

const pomCache = new Map<string, string | null>();

/** A library's POM, from Gradle's cache or the repository that serves it. */
async function pomOf(group: string, artifact: string, version: string): Promise<string | null> {
  const key = `${group}:${artifact}:${version}`;
  if (pomCache.has(key)) return pomCache.get(key)!;
  let pom: string | null = null;
  const cached = path.join(gradleCache, group, artifact, version);
  if (fs.existsSync(cached)) {
    for (const hash of fs.readdirSync(cached)) {
      const file = path.join(cached, hash, `${artifact}-${version}.pom`);
      if (fs.existsSync(file)) pom = fs.readFileSync(file, 'utf8');
    }
  }
  for (const repository of pom ? [] : repositories) {
    const response = await fetch(
      `${repository}/${group.replaceAll('.', '/')}/${artifact}/${version}/${artifact}-${version}.pom`,
    );
    if (response.ok) {
      pom = await response.text();
      break;
    }
  }
  pomCache.set(key, pom);
  return pom;
}

const tag = (xml: string, name: string) =>
  new RegExp(`<${name}>\\s*([\\s\\S]*?)\\s*</${name}>`).exec(xml)?.[1]?.trim() ?? null;

interface PomFacts {
  licences: string[];
  url: string | null;
  holder: string | null;
  packaging: string | null;
}

/** What a POM says, filling in from its parents what it leaves out. */
async function factsOf(group: string, artifact: string, version: string, depth = 0): Promise<PomFacts> {
  const pom = await pomOf(group, artifact, version);
  if (!pom) throw new Error(`No POM found for ${group}:${artifact}:${version}.`);
  const licencesBlock = tag(pom, 'licenses') ?? '';
  const facts: PomFacts = {
    licences: [...licencesBlock.matchAll(/<license>[\s\S]*?<name>\s*([\s\S]*?)\s*<\/name>/g)].map((m) => m[1]!.trim()),
    url: tag(pom.replace(/<(parent|licenses|scm|organization|developers|dependencies|distributionManagement)>[\s\S]*?<\/\1>/g, ''), 'url')
      ?? tag(tag(pom, 'scm') ?? '', 'url'),
    holder: tag(tag(pom, 'organization') ?? '', 'name')
      ?? tag(tag(pom, 'developer') ?? '', 'organization')
      ?? tag(tag(pom, 'developer') ?? '', 'name'),
    packaging: tag(pom.replace(/<(parent|dependencies|build)>[\s\S]*?<\/\1>/g, ''), 'packaging'),
  };
  const parent = tag(pom, 'parent');
  if (parent && depth < 5 && (facts.licences.length === 0 || !facts.url || !facts.holder)) {
    const inherited = await factsOf(tag(parent, 'groupId')!, tag(parent, 'artifactId')!, tag(parent, 'version')!, depth + 1);
    if (facts.licences.length === 0) facts.licences = inherited.licences;
    facts.url ??= inherited.url;
    facts.holder ??= inherited.holder;
  }
  return facts;
}

async function main() {
  const androidDir = process.argv[2];
  if (!androidDir || !fs.existsSync(path.join(androidDir, 'gradlew'))) {
    console.error('usage: npm run licences:android -- <a prebuilt android/ directory>');
    process.exit(1);
  }
  const fromNpm = npmCoordinates();
  const groups = new Map<string, AndroidGroup>();
  for (const coordinate of shippedCoordinates(path.resolve(androidDir))) {
    const [group, artifact, version] = coordinate.split(':') as [string, string, string];
    if (fromNpm.has(`${group}:${artifact}`)) continue;
    const facts = await factsOf(group, artifact, version);
    // A BOM pins versions and ships nothing.
    if (facts.packaging === 'pom') continue;
    if (facts.licences.length === 0) throw new Error(`${coordinate} declares no licence.`);
    const declared = facts.licences.join(' OR ');
    const licence = facts.licences.map(spdxOf).join(' OR ');
    const correction = CORRECTIONS[`${group}:${artifact}`] ?? {};
    const androidx = group.startsWith('androidx.') && !correction.name;
    const name = correction.name ?? (androidx ? ANDROIDX.name : group);
    // One row per project and licence: a group that mixes two lists each apart.
    const key = `${name}|${licence}`;
    const entry = groups.get(key) ?? {
      name,
      licence,
      declared: declared === licence ? null : declared,
      url: correction.url ?? (androidx ? ANDROIDX.url : facts.url),
      holder: correction.holder ?? facts.holder,
      artifacts: [],
    };
    entry.artifacts.push(androidx ? `${group}:${artifact} ${version}` : `${artifact} ${version}`);
    entry.url ??= facts.url;
    entry.holder ??= facts.holder;
    groups.set(key, entry);
  }

  const reactNative = JSON.parse(
    fs.readFileSync(path.join(root, 'node_modules/react-native/package.json'), 'utf8'),
  ).version as string;
  const data = {
    about: [
      'The Maven libraries the Android app ships, from its release runtime classpath,',
      'with the licence each POM declares. Generated by scripts/licencesAndroid.mts;',
      'run `npm run licences:android -- <prebuilt android/>` after an Android',
      'dependency changes, then `npm run licences`.',
    ],
    reactNative,
    groups: [...groups.values()].sort((a, b) => a.name.localeCompare(b.name) || a.licence.localeCompare(b.licence)),
  };
  fs.writeFileSync(output, `${JSON.stringify(data, null, 1)}\n`);
  const libraries = data.groups.reduce((sum, group) => sum + group.artifacts.length, 0);
  console.log(`Wrote ${path.relative(root, output)}: ${libraries} libraries in ${data.groups.length} groups.`);
  const unnamed = data.groups.filter((group) => !group.holder && group.licence !== 'Apache-2.0').map((group) => group.name);
  if (unnamed.length > 0) console.log(`No organisation in the POM of: ${unnamed.join(', ')}.`);
}

await main();
