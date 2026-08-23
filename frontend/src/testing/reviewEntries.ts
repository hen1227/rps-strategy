// Review-entry fixtures.
//
// A report is a fold over the worker's entries, so most questions about a
// report can be asked without an engine — as long as the entries are complete.
// Building them here keeps a field added to `ReviewEntry` from breaking every
// test that ever needed one.

import type { Analysis, ReviewEntry } from '@/engine/rpsfish/protocol';
import type { Move } from '@/types/game';

/** A finished search that saw nothing: level, no lines, no moves offered. */
export const levelAnalysis = (overrides: Partial<Analysis> = {}): Analysis => ({
  confidence: 100,
  depth: 6,
  elapsedMs: 1,
  lines: [],
  nodes: 0,
  nodesPerSecond: 0,
  redScore: 0,
  score: 0,
  selectiveDepth: 6,
  stopReason: 'depth',
  ...overrides,
});

/** One entry whose played move gave up exactly nothing. */
export const levelEntry = (index: number, overrides: Partial<ReviewEntry> = {}): ReviewEntry => ({
  index,
  analysis: levelAnalysis(),
  baselineScore: 0,
  played: null,
  playedScore: 0,
  playedVariation: null,
  ...overrides,
});

/** `count` entries good enough to grade against: every move loses nothing. */
export const levelEntries = (count: number): ReviewEntry[] =>
  Array.from({ length: count }, (unused, index) => levelEntry(index));

/** An entry that threw the game away, for testing what accuracy does with one. */
export const blunderEntry = (index: number, played: Move | null = null): ReviewEntry =>
  levelEntry(index, { baselineScore: 900, playedScore: -900, played });
