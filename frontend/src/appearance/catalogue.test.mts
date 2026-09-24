import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { BOARDS, THEMES, boardById, themeById } from '../theme/index.ts';
import { PIECE_SETS, pieceSetById } from './pieceSets.ts';
import { SOUND_PACKS, soundPackById } from './soundPacks.ts';
import { SOUND_WAVEFORMS } from './soundWaveforms.ts';
import { DEFAULT_APPEARANCE, appearanceFromJson } from './preference.ts';

const HERE = dirname(fileURLToPath(import.meta.url));

// Every axis answers an unknown id with its default rather than with nothing.
//
// This is the rule the whole feature rests on: ids are stored on the device and
// synced through a server that does not know what they mean, so a look chosen in
// a build that has a preset this one does not — a newer phone, an older web
// build — has to render *something*. The same rule `titleTone` has always had.
test('an id from another build falls back instead of rendering nothing', () => {
  strictEqual(themeById('a-theme-from-next-year').id, THEMES[0]!.id);
  strictEqual(boardById(undefined).id, BOARDS[0]!.id);
  strictEqual(pieceSetById(null).id, PIECE_SETS[0]!.id);
  strictEqual(soundPackById('').id, SOUND_PACKS[0]!.id);
});

test('a stored look falls back field by field, not wholesale', () => {
  // Three axes this build knows and one it does not: the three must survive.
  const parsed = appearanceFromJson(
    '{"theme":"midnight","board":"ink","pieces":"marks","sound":"a-pack-from-next-year"}',
  );
  deepStrictEqual(parsed, {
    theme: 'midnight',
    board: 'ink',
    pieces: 'marks',
    sound: 'a-pack-from-next-year',
  });
  // And the ids that mean nothing here still resolve to something drawable.
  strictEqual(soundPackById(parsed.sound).id, SOUND_PACKS[0]!.id);

  deepStrictEqual(appearanceFromJson('not json at all'), DEFAULT_APPEARANCE);
  deepStrictEqual(appearanceFromJson(null), DEFAULT_APPEARANCE);
  deepStrictEqual(appearanceFromJson('{"theme":42}'), DEFAULT_APPEARANCE);
});

test('ids are unique within each axis', () => {
  for (const [axis, ids] of [
    ['theme', THEMES.map((t) => t.id)],
    ['board', BOARDS.map((b) => b.id)],
    ['pieces', PIECE_SETS.map((s) => s.id)],
    ['sound', SOUND_PACKS.map((p) => p.id)],
  ] as const) {
    strictEqual(new Set(ids).size, ids.length, `duplicate id on the ${axis} axis`);
  }
});

// A pack with a missing clip would be a silent event nobody asked to silence,
// and the hook builds one player per name — so a name it has no entry for is a
// player with an undefined source rather than a deliberate `null`.
test('every sound pack answers for every event', () => {
  const events = Object.keys(SOUND_PACKS[0]!.sources).sort();
  strictEqual(events.length, 9);
  for (const pack of SOUND_PACKS) {
    deepStrictEqual(Object.keys(pack.sources).sort(), events, `${pack.id} is missing an event`);
  }
  // Silence is a pack of nulls rather than a flag checked somewhere else, which
  // is what keeps it out of every branch in the sound layer.
  const silent = soundPackById('silent');
  for (const [event, source] of Object.entries(silent.sources)) {
    strictEqual(source, null, `the silent pack makes a sound for ${event}`);
  }
});

// Both sides, all three kinds. A set missing one draws a letter disc where a
// piece should be, which reads as a broken board rather than a missing file.
test('every piece set can draw all three kinds', () => {
  for (const set of PIECE_SETS) {
    for (const side of ['Red', 'Blue'] as const) {
      for (const kind of ['rock', 'paper', 'scissors']) {
        ok(set.raster[side][kind], `${set.id} has no ${side} ${kind}`);
      }
    }
  }
});

test('every preset names itself for the picker', () => {
  for (const entry of [...THEMES, ...BOARDS, ...PIECE_SETS, ...SOUND_PACKS]) {
    ok(entry.name.trim().length > 0, `${entry.id} has no name`);
    ok(entry.blurb.trim().length > 0, `${entry.id} has no blurb`);
  }
});


// The three tests below all lean on the same thing: under the test loader an
// asset `require` evaluates to the string `asset:<the literal path>`, so the
// paths a pack claims can be checked here rather than at bundle time on a
// device.

// Metro reads the literal inside `require` and bundles what it finds. A path
// that is wrong in any way builds a pack that plays nothing, and on web it can
// still *work* — the dev server will serve a file the bundler never saw — so
// this is a fault that reaches a phone and stops there.
test('every clip a pack names is actually on disk', () => {
  for (const pack of SOUND_PACKS) {
    for (const [event, source] of Object.entries(pack.sources)) {
      if (source === null) continue;
      const path = String(source).replace(/^asset:/, '');
      ok(
        existsSync(resolve(HERE, path)),
        `${pack.id} points ${event} at ${path}, which does not exist`,
      );
    }
  }
});

// A new pack starts life as a copy of an old one, and the copy that is missed
// is the directory in nine require paths. The result is two entries in the
// picker that sound identical, which reads as the picker being broken.
test('an audible pack plays its own clips and nothing else', () => {
  for (const pack of SOUND_PACKS) {
    if (pack.id === 'silent') continue;
    for (const [event, source] of Object.entries(pack.sources)) {
      ok(source, `${pack.id} has no clip for ${event} but is not the silent pack`);
      ok(
        String(source).includes(`/sounds/${pack.id}/`),
        `${pack.id} plays ${String(source)} for ${event}, which belongs to another pack`,
      );
    }
  }
});

// The picker draws each pack as the waveform of its own move clip. A pack with
// no entry draws a flat line — which is the honest picture for Silent and a
// lie for everything else, and a silent-looking chip is not a thing anyone
// would think to click.
test('every audible pack has a waveform for the picker', () => {
  for (const pack of SOUND_PACKS) {
    const drawn = SOUND_WAVEFORMS[pack.id];
    if (pack.id === 'silent') {
      strictEqual(drawn, undefined, 'the silent pack should draw a flat line, not a shape');
      continue;
    }
    ok(drawn?.length, `${pack.id} has no waveform — rerun tools/generate-game-sounds.py`);
    ok(
      drawn.some((v) => v > 0),
      `${pack.id} draws a waveform that is flat everywhere`,
    );
  }
});

// Every account that ever chose a sound chose `classic`, the only pack there
// was. That id is gone, and the fallback is what turns those accounts into Wood
// rather than into silence.
test('the pack everyone used to have falls back to the new default', () => {
  strictEqual(soundPackById('classic').id, 'wood');
  strictEqual(soundPackById('classic').id, SOUND_PACKS[0]!.id);
  // Silent was the other thing they could have chosen, and it still exists.
  strictEqual(soundPackById('silent').id, 'silent');
});
