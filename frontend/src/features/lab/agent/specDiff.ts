// What actually changed, in the words a person would use.
//
// A patch is the wrong thing to show somebody. `lab_patch_spec` takes a fragment
// of the rule format, and the fragment for "pieces can now leap" is a nested
// object with an offsets array in it — true, complete, and unreadable at a
// glance. The interesting fact is almost always small: the board got smaller, a
// piece appeared, a win condition went away. So this diffs the draft before and
// after a tool ran and names the differences.
//
// Deliberately shallow. It reports the things a designer thinks in, and says
// nothing rather than guessing when a change does not fit one of them — a chip
// that reads "movement changed" is worth more than a chip that reads
// "movement[2].dirs.offsets[1][0]: 1 → 2".

import type { RuleSpec } from '@/engine/spec/types';

export interface SpecChange {
  label: string;
  kind: 'add' | 'remove' | 'change';
}

const countLabel = (n: number, one: string, many = `${one}s`) =>
  `${n} ${n === 1 ? one : many}`;

/** Names of the pieces, by id, for reporting an arrival by its name. */
const pieceNames = (spec: RuleSpec): Map<string, string> =>
  new Map((spec.pieces ?? []).map((piece) => [piece.id, piece.name || piece.id]));

const listChange = (
  before: readonly unknown[] | undefined,
  after: readonly unknown[] | undefined,
  one: string,
  many?: string,
): SpecChange | null => {
  const from = before?.length ?? 0;
  const to = after?.length ?? 0;
  if (from === to) {
    // Same count, different content: worth saying, not worth enumerating.
    const same = JSON.stringify(before ?? []) === JSON.stringify(after ?? []);
    return same ? null : { label: `${many ?? `${one}s`} changed`, kind: 'change' };
  }
  return to > from
    ? { label: `+${countLabel(to - from, one, many)}`, kind: 'add' }
    : { label: `−${countLabel(from - to, one, many)}`, kind: 'remove' };
};

/**
 * The chips for one tool call.
 *
 * Returns nothing for a call that changed nothing, which is the common case:
 * most tools read.
 */
export const describeSpecChange = (before: RuleSpec, after: RuleSpec): SpecChange[] => {
  if (before === after) return [];
  const changes: SpecChange[] = [];

  if (before.name !== after.name) {
    changes.push({ label: `named “${after.name}”`, kind: 'change' });
  }

  if (before.board?.width !== after.board?.width || before.board?.height !== after.board?.height) {
    changes.push({
      label: `board ${before.board?.width}×${before.board?.height} → ${after.board?.width}×${after.board?.height}`,
      kind: 'change',
    });
  }

  // Pieces get named, because "+1 piece" and "+Lizard" cost the same space.
  const was = pieceNames(before);
  const now = pieceNames(after);
  for (const [id, name] of now) if (!was.has(id)) changes.push({ label: `+${name}`, kind: 'add' });
  for (const [id, name] of was) if (!now.has(id)) changes.push({ label: `−${name}`, kind: 'remove' });

  for (const change of [
    listChange(before.movement, after.movement, 'move'),
    listChange(before.win, after.win, 'win rule'),
    listChange(before.effects, after.effects, 'effect'),
    listChange(before.beats, after.beats, 'matchup'),
  ]) {
    if (change) changes.push(change);
  }

  if (before.capture?.mode !== after.capture?.mode && after.capture?.mode) {
    changes.push({ label: `capture: ${after.capture.mode}`, kind: 'change' });
  }

  const startingBefore = JSON.stringify(before.startingPosition ?? null);
  const startingAfter = JSON.stringify(after.startingPosition ?? null);
  if (startingBefore !== startingAfter) {
    changes.push({ label: 'new opening board', kind: 'change' });
  }

  if (before.objective !== after.objective && after.objective) {
    changes.push({ label: 'new objective', kind: 'change' });
  }

  // Pictures, named the way a designer would. Which kinds got one is a list, not
  // a fact, so this counts them and stops — and never shows a digest, which is
  // the least readable thing the format contains.
  const drawn = (spec: RuleSpec) => (spec.pieces ?? []).filter((piece) => piece.art).length;
  const wasDrawn = drawn(before);
  const nowDrawn = drawn(after);
  if (nowDrawn > wasDrawn) {
    changes.push({
      label: nowDrawn - wasDrawn === 1 ? 'a piece got a picture' : 'pieces got pictures',
      kind: 'add',
    });
  } else if (nowDrawn < wasDrawn) {
    changes.push({ label: 'a piece lost its picture', kind: 'remove' });
  }
  if (before.board?.art !== after.board?.art) {
    changes.push(
      after.board?.art
        ? { label: 'board picture', kind: 'add' }
        : { label: 'board picture removed', kind: 'remove' },
    );
  }
  if (before.cover !== after.cover) {
    changes.push(
      after.cover
        ? { label: 'new cover', kind: 'add' }
        : { label: 'cover removed', kind: 'remove' },
    );
  }

  return changes;
};
