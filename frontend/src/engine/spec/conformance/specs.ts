// The modes the conformance corpus is recorded against.
//
// The two shipped ones are here because they are the games whose right answers
// are already written down. The rest exist to exercise the parts of the language
// the shipped ones never touch — a jump, a slider, a knight, a promotion, a
// forced capture, five piece kinds, a board that is not square — because those
// are exactly the rules where two interpreters can quietly disagree and no
// existing test would notice.
//
// Every one of them is deliberately small and strange. They are not modes
// anybody should play; they are modes that make an interpreter show its work.

import { INFILTRATION_SPEC, TOTAL_WAR_SPEC } from '../builtin';
import { SPEC_VERSION, type RuleSpec } from '../types';

const rows = (height: number, width: number) =>
  Array.from({ length: height }, () => '.'.repeat(width));

const withRow = (base: string[], index: number, row: string) => {
  const copy = [...base];
  copy[index] = row;
  return copy;
};

/** Checkers on a small board: pieces jump, and a jump is compulsory. */
const JUMPERS: RuleSpec = {
  spec: SPEC_VERSION,
  name: 'Jumpers',
  shortCode: 'JMP',
  description: 'Leap the piece in front of you.',
  objective: 'Take everything.',
  board: { width: 7, height: 7 },
  pieces: [{ id: 'Rock', name: 'Rock', symbol: 'R', art: 'rock' }],
  // Nothing beats anything, so the only way to take a piece is to jump it —
  // which is what makes the jump rule the whole game rather than a flourish.
  beats: [],
  startingPosition: {
    rows: [
      'R.R.R.R',
      '.......',
      '.......',
      '...R...',
      '.......',
      '.......',
      'r.r.r.r',
    ],
  },
  movement: [
    { kind: 'step', dirs: 'all8', distance: 1, targets: 'empty' },
    { kind: 'jumpOver', dirs: 'all8', captureJumped: true, mustCapture: true },
  ],
  capture: { mode: 'always' },
  win: [
    {
      id: 'annihilation',
      when: { eq: [{ count: { owner: 'opponent' } }, 0] },
      result: 'mover',
      reason: 'annihilation',
    },
  ],
};

/** Sliders and a knight, on a rectangle, so geometry has somewhere to go wrong. */
const LONG_REACH: RuleSpec = {
  spec: SPEC_VERSION,
  name: 'Long Reach',
  shortCode: 'LR',
  description: 'One piece slides, one leaps.',
  objective: 'Reach the far rank.',
  board: { width: 8, height: 5 },
  pieces: [
    { id: 'Rook', name: 'Rook', symbol: 'R' },
    { id: 'Knight', name: 'Knight', symbol: 'N' },
  ],
  beats: [
    ['Rook', 'Knight'],
    ['Knight', 'Rook'],
  ],
  startingPosition: {
    rows: withRow(withRow(rows(5, 8), 0, 'R.N....R'), 4, 'r....n.r'),
  },
  movement: [
    { kind: 'slide', dirs: 'orthogonal', maxDistance: 4, piece: 'Rook' },
    {
      kind: 'leap',
      piece: 'Knight',
      dirs: {
        offsets: [
          [1, 2],
          [2, 1],
          [2, -1],
          [1, -2],
          [-1, -2],
          [-2, -1],
          [-2, 1],
          [-1, 2],
        ],
      },
    },
  ],
  win: [
    {
      id: 'reach',
      when: { in: ['to', { home: 'opponent' }] },
      result: 'mover',
      reason: 'infiltration',
    },
  ],
};

/** One-way pieces that promote, so `forward` and `promote` are both exercised. */
const MARCH: RuleSpec = {
  spec: SPEC_VERSION,
  name: 'March',
  shortCode: 'MAR',
  description: 'Advance, and become something else at the end.',
  objective: 'Hold most of the board.',
  board: { width: 6, height: 6 },
  pieces: [
    { id: 'Pawn', name: 'Pawn', symbol: 'P' },
    { id: 'Queen', name: 'Queen', symbol: 'Q' },
  ],
  beats: [
    ['Pawn', 'Pawn'],
    ['Queen', 'Pawn'],
    ['Queen', 'Queen'],
    ['Pawn', 'Queen'],
  ],
  startingPosition: {
    rows: withRow(withRow(rows(6, 6), 1, 'PPPPPP'), 4, 'pppppp'),
  },
  movement: [
    // Offsets are in the mover's own frame, so one rule advances both sides.
    { kind: 'step', dirs: 'forward', distance: 1, piece: 'Pawn', targets: 'empty' },
    { kind: 'step', dirs: 'forwardDiagonal', distance: 1, piece: 'Pawn', targets: 'enemy' },
    { kind: 'step', dirs: 'all8', distance: 1, piece: 'Queen' },
  ],
  effects: [
    {
      on: 'move',
      when: { and: [{ moved: 'Pawn' }, { in: ['to', { home: 'opponent' }] }] },
      do: [{ promote: { to: 'Queen' } }],
    },
    { on: 'move', do: [{ claimTerritory: 'mover' }] },
  ],
  win: [
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
  draw: { moveLimit: 120 },
};

/** Five kinds and a lopsided graph, so the beats lookup cannot be a three-cycle. */
const MENAGERIE: RuleSpec = {
  spec: SPEC_VERSION,
  name: 'Menagerie',
  shortCode: 'MEN',
  description: 'Five kinds, and not a cycle among them.',
  objective: 'Take the last piece.',
  board: { width: 5, height: 5 },
  pieces: [
    { id: 'Rock', name: 'Rock', symbol: 'R' },
    { id: 'Paper', name: 'Paper', symbol: 'P' },
    { id: 'Scissors', name: 'Scissors', symbol: 'S' },
    { id: 'Lizard', name: 'Lizard', symbol: 'L' },
    { id: 'Spock', name: 'Spock', symbol: 'K' },
  ],
  beats: [
    ['Rock', 'Scissors'],
    ['Rock', 'Lizard'],
    ['Paper', 'Rock'],
    ['Paper', 'Spock'],
    ['Scissors', 'Paper'],
    ['Scissors', 'Lizard'],
    ['Lizard', 'Paper'],
    ['Lizard', 'Spock'],
    ['Spock', 'Rock'],
    ['Spock', 'Scissors'],
  ],
  startingPosition: {
    rows: ['RPSLK', '.....', '.....', '.....', 'rpslk'],
  },
  movement: [{ kind: 'step', dirs: 'all8', distance: 1 }],
  win: [
    {
      id: 'annihilation',
      when: { eq: [{ count: { owner: 'opponent' } }, 0] },
      result: 'mover',
      reason: 'annihilation',
    },
    {
      // Reduced to three pieces and you have lost, which takes two captures
      // from the opening rather than none — a win condition that fires on move
      // one would test the ordering and nothing else.
      id: 'outnumbered',
      when: { lte: [{ count: { owner: 'opponent' } }, 3] },
      result: 'mover',
      reason: 'game_rule',
    },
  ],
};

/** Nothing is ever captured, and the only way out is running out of room. */
const PEACEFUL: RuleSpec = {
  spec: SPEC_VERSION,
  name: 'Peaceful',
  shortCode: 'PAX',
  description: 'Nobody takes anybody.',
  objective: 'Claim the ground.',
  board: { width: 4, height: 4 },
  pieces: [{ id: 'Stone', name: 'Stone', symbol: 'T' }],
  beats: [],
  capture: { mode: 'never' },
  startingPosition: { rows: ['TT..', '....', '....', '..tt'] },
  movement: [{ kind: 'step', dirs: 'orthogonal', distance: 1 }],
  effects: [{ on: 'move', do: [{ claimTerritory: 'mover' }] }],
  win: [
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
  draw: { moveLimit: 60 },
};

export const CORPUS_SPECS: Record<string, RuleSpec> = {
  totalWar: TOTAL_WAR_SPEC,
  infiltration: INFILTRATION_SPEC,
  jumpers: JUMPERS,
  longReach: LONG_REACH,
  march: MARCH,
  menagerie: MENAGERIE,
  peaceful: PEACEFUL,
};
