// Mode fixtures for tests and measurement scripts.
//
// Every test that needs a board needs a `ModeDefinition`, and only two of its
// fields matter to the rules: the id the rules switch on and the starting
// position. Building them here means a field added to `ModeDefinition` is
// added once rather than in every test file.

import type { ModeDefinition, ModeFeature, ModeID } from '@/types/game';

/** The board the two rank-goal modes open from. */
export const STANDARD_OPENING_ROWS = [
  '...SSS...', '...PPP...', '...RRR...',
  '.........', '.........', '.........',
  '...rrr...', '...ppp...', '...sss...',
];

/** Intransitive's diagonal opening, which is the only one that differs. */
export const INTRANSITIVE_OPENING_ROWS = [
  '.........', '...RP....', '..RPS....',
  '.RPS.....', '.PS...sp.', '.....spr.',
  '....spr..', '....pr...', '.........',
];

const MODE_NAMES: Record<string, string> = {
  V5: 'Total War',
  V3: 'Infiltration',
  V6: 'Intransitive',
};

const MODE_FEATURES: Record<string, ModeFeature[]> = {
  V5: ['territory'],
  V6: ['no_repetition_draw', 'stalemate_loses'],
};

const MODE_OPENINGS: Record<string, string[]> = {
  V6: INTRANSITIVE_OPENING_ROWS,
};

/** A complete `ModeDefinition` for one mode id. */
export const testMode = (
  id: ModeID,
  overrides: Partial<ModeDefinition> = {},
): ModeDefinition => ({
  id,
  shortCode: id,
  name: MODE_NAMES[id] ?? id,
  description: '',
  objective: '',
  displayOrder: 0,
  playable: true,
  features: MODE_FEATURES[id] ?? [],
  startingPosition: { rows: [...(MODE_OPENINGS[id] ?? STANDARD_OPENING_ROWS)] },
  ...overrides,
});

/** Every shipped mode, for a script that sweeps all of them. */
export const ALL_TEST_MODES: readonly ModeDefinition[] = ['V5', 'V3', 'V6'].map((id) =>
  testMode(id),
);
