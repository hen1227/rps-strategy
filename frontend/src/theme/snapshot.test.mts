import { deepStrictEqual } from 'node:assert/strict';
import { test } from 'node:test';

import { boardById } from './boards.ts';
import { buildTheme } from './buildTheme.ts';
import { FOREST_SNAPSHOT } from './forestSnapshot.ts';
import { THEMES } from './themes/index.ts';
import { BOARDS } from './boards.ts';

// The day themes arrived is not a day anybody's board should have changed
// colour. `forest` is the look this app already had, so building it has to
// produce the values the old single palette produced — all of them, exactly.
test('the forest theme on the forest board is what the app already looked like', () => {
  const built = buildTheme(THEMES[0]!, boardById('forest'));
  // Compared group by group rather than as one object, so a failure names the
  // group that moved instead of printing two hundred lines of colours.
  for (const [group, expected] of Object.entries(FOREST_SNAPSHOT)) {
    deepStrictEqual(
      JSON.parse(JSON.stringify(built[group as keyof typeof built])),
      JSON.parse(JSON.stringify(expected)),
      `theme group "${group}" no longer matches the original palette`,
    );
  }
});

// A preset that forgot a role would not fail to compile — every field is a
// string — but it would draw something invisible. This is the cheap check that
// each one is fully populated, on every board, before anybody sees it.
test('every theme builds every token against every board', () => {
  for (const theme of THEMES) {
    for (const boardSpec of BOARDS) {
      const built = buildTheme(theme, boardSpec);
      const walk = (value: unknown, path: string) => {
        if (typeof value === 'string') {
          if (value.trim() === '') throw new Error(`${theme.id}/${boardSpec.id}: ${path} is empty`);
          return;
        }
        if (typeof value === 'number') return;
        if (value === null || value === undefined) {
          throw new Error(`${theme.id}/${boardSpec.id}: ${path} is missing`);
        }
        for (const [key, child] of Object.entries(value as object)) walk(child, `${path}.${key}`);
      };
      walk(built.colors, 'colors');
      walk(built.players, 'players');
      walk(built.board, 'board');
      walk(built.reach, 'reach');
      walk(built.clock, 'clock');
      walk(built.podium, 'podium');
    }
  }
});
