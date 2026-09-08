// What this account may not do, asked as a question rather than read as a list.
//
// The server sends the restrictions in force and refreshes them whenever a
// moderator acts, so nothing here polls. What it does do is check the deadline,
// because a mute placed for an hour lapses while the client is sitting on the
// same page — and a chat box that stays disabled for twenty minutes after the
// mute ended is the same bug as one that stays enabled during it.

import type { Restriction, RestrictionKind } from '@/types/protocol';

/**
 * The restriction of one kind that is in force, or null.
 *
 * `now` is a parameter rather than `Date.now()` so a caller that re-renders on
 * a clock — see `useNow` — re-evaluates this with it, and so the whole thing
 * stays a pure function that a test can pin to an instant.
 */
export const activeRestriction = (
  restrictions: Restriction[],
  kind: RestrictionKind,
  now = Date.now(),
): Restriction | null =>
  restrictions.find(
    (restriction) =>
      restriction.kind === kind &&
      (restriction.expiresAtUnixMs === undefined || restriction.expiresAtUnixMs > now),
  ) ?? null;

/**
 * A restriction in the words the person under it reads.
 *
 * `verb` finishes the sentence: `restrictionNotice(mute, 'chat')` gives "You
 * cannot chat for another 20 minutes: spamming the lobby." Both halves matter —
 * a refusal with no deadline and no reason is the one that generates a
 * complaint rather than answering it.
 */
export const restrictionNotice = (
  restriction: Restriction,
  verb: string,
  now = Date.now(),
): string => {
  const parts = [`You cannot ${verb}`];
  if (restriction.expiresAtUnixMs !== undefined) {
    parts.push(`for another ${remainingLabel(restriction.expiresAtUnixMs - now)}`);
  }
  const sentence = parts.join(' ');
  // Both forms end in a full stop. This reads as a sentence in a placeholder
  // and in a banner, and the version with a reason was the one that did not —
  // which is the sort of thing only a test notices.
  return restriction.reason ? `${sentence}: ${restriction.reason}.` : `${sentence}.`;
};

/**
 * How long is left, in the units somebody reads it in.
 *
 * Deliberately coarse, and it matches the server's own wording so the two
 * cannot disagree by a minute over the same restriction. "23 minutes" is what a
 * person needs; a precise countdown is what a stopwatch needs.
 */
const remainingLabel = (remaining: number): string => {
  const minutes = Math.ceil(remaining / 60_000);
  if (minutes <= 1) return 'under a minute';
  if (minutes < 60) return `${minutes} minutes`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return hours === 1 ? 'an hour' : `${hours} hours`;
  return `${Math.round(hours / 24)} days`;
};
