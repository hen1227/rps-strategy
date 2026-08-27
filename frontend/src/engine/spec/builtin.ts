// The two shipped modes, written in the rule language.
//
// These are not decoration and they are not documentation. They are the
// correctness proof for the whole language: `spec.test.mts` plays seeded random
// games through the interpreter reading these and through
// `analysisGame.ts`'s hand-written V3/V5 branches, and asserts the two agree
// position for position. A language that cannot express the games this project
// already ships is a language that would have quietly failed on somebody's
// first invention instead.
//
// The Go side keeps its own copy in `backend/internal/game/spec/builtin.go`, and
// a differential test there does the same job against `TotalWarMode` and
// `InfiltrationMode`. Change one of these and both suites fail, which is the
// point.

import { SPEC_VERSION, type PieceKindSpec, type RuleSpec } from './types';

/**
 * Rock, paper and scissors, and the single three-cycle between them.
 *
 * A spec may declare any kinds and any `beats` graph; these are the standard
 * ones, exported because most authors will start from them and because the
 * built-in specs below have to use exactly the letters every archived record
 * already spells its pieces with.
 */
// The ids are `Rock`, `Paper` and `Scissors` rather than lower-case names, and
// that is the whole point of them: a kind's id is the string that appears in
// `Tile.occupant`, so these are the values every board, record and wire message
// in this project has always carried. One name per piece, and no table
// translating between the rules and the position they are about.
export const STANDARD_PIECES: PieceKindSpec[] = [
  { id: 'Rock', name: 'Rock', symbol: 'R', art: 'rock' },
  { id: 'Paper', name: 'Paper', symbol: 'P', art: 'paper' },
  { id: 'Scissors', name: 'Scissors', symbol: 'S', art: 'scissors' },
];

export const STANDARD_BEATS: RuleSpec['beats'] = [
  ['Rock', 'Scissors'],
  ['Scissors', 'Paper'],
  ['Paper', 'Rock'],
];

const STANDARD_ROWS = [
  '...SSS...',
  '...PPP...',
  '...RRR...',
  '.........',
  '.........',
  '.........',
  '...rrr...',
  '...ppp...',
  '...sss...',
];

/** Everything the two shipped modes have in common. */
const standardBase = {
  spec: SPEC_VERSION,
  board: { width: 9, height: 9 },
  pieces: STANDARD_PIECES,
  beats: STANDARD_BEATS,
  startingPosition: { rows: STANDARD_ROWS },
  // One king step, onto an empty square or onto something this kind beats.
  // `targets: 'any'` plus `capture: {mode: 'beats'}` is what says "or onto
  // something it beats": the capture rule filters the targets rather than the
  // movement rule naming them, so a mode can change who takes whom without
  // touching how anything moves.
  movement: [{ kind: 'step' as const, dirs: 'all8' as const, distance: 1 }],
  capture: { mode: 'beats' as const },
} satisfies Partial<RuleSpec>;

/**
 * Total War: take the enemy off the board, or hold most of it when it fills.
 *
 * The order of the two win conditions is the rule, not a preference. A move that
 * takes the last enemy piece *and* claims the last neutral square is an
 * annihilation win, because annihilation is checked first — which is exactly
 * what `mode_total_war.go` does by returning before it counts territory.
 */
export const TOTAL_WAR_SPEC: RuleSpec = {
  ...standardBase,
  name: 'Total War',
  shortCode: 'V5',
  description: 'Pieces and territory.',
  objective: 'Annihilate the enemy or control most territory when the board is filled.',
  effects: [{ on: 'move', do: [{ claimTerritory: 'mover' }] }],
  win: [
    {
      id: 'annihilation',
      when: { eq: [{ count: { owner: 'opponent' } }, 0] },
      result: 'mover',
      reason: 'annihilation',
    },
    {
      id: 'territory',
      when: { eq: [{ count: { territory: 'neutral' } }, 0] },
      result: {
        moreOf: {
          red: { count: { territory: 'red' } },
          blue: { count: { territory: 'blue' } },
        },
      },
      reason: 'territory',
    },
  ],
};

/**
 * Infiltration: walk a piece onto the far rank.
 *
 * No annihilation rule, deliberately, and that absence is a rule of its own:
 * losing every piece leaves the player to move with no legal move, which the
 * engine adjudicates as a stalemate draw rather than a loss. `game_test.go`
 * asserts it, and a spec that "helpfully" added an annihilation condition here
 * would be a different game.
 */
export const INFILTRATION_SPEC: RuleSpec = {
  ...standardBase,
  name: 'Infiltration',
  shortCode: 'V3',
  description: 'A race to the far rank.',
  objective: "Move a piece onto the opponent's home rank.",
  win: [
    {
      id: 'infiltration',
      when: { in: ['to', { home: 'opponent' }] },
      result: 'mover',
      reason: 'infiltration',
    },
  ],
};

/** The shipped specs by mode id, for the differential tests and the Lab. */
export const BUILTIN_SPECS: Record<string, RuleSpec> = {
  V5: TOTAL_WAR_SPEC,
  V3: INFILTRATION_SPEC,
};
