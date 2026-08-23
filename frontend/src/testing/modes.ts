// Mode fixtures for tests and measurement scripts.
//
// Every test that needs a board needs a `ModeDefinition`, and only two of its
// fields matter to the rules: the id the rules switch on and the starting
// position. Building them here means a field added to `ModeDefinition` is
// added once rather than in every test file.

import type { ModeDefinition, ModeFeature, ModeID } from '@/types/game';

/** The board every current mode opens from. */
export const STANDARD_OPENING_ROWS = [
  '...SSS...', '...PPP...', '...RRR...',
  '.........', '.........', '.........',
  '...rrr...', '...ppp...', '...sss...',
];

const MODE_NAMES: Record<string, string> = {
  V1: 'Annihilation',
  V5: 'Total War',
  V3: 'Infiltration',
};

const MODE_FEATURES: Record<string, ModeFeature[]> = {
  V5: ['territory'],
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
  startingPosition: { rows: [...STANDARD_OPENING_ROWS] },
  ...overrides,
});

/** All three shipped modes, for a script that sweeps every one of them. */
export const ALL_TEST_MODES: readonly ModeDefinition[] = ['V1', 'V5', 'V3'].map((id) =>
  testMode(id),
);
