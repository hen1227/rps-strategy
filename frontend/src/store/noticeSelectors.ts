// Whether the announcement the server last broadcast is still up.
//
// The server holds one notice with a lifetime and stops handing it out once it
// lapses — but nothing arrives to say so. `noticeBoard.current` checks expiry on
// read precisely to avoid a timer for a single pointer, which means a client
// holding the last broadcast has to do the same check itself.
//
// So this is that check, as a pure function of the notice and the clock. It is
// what lets the admin screen say "23 minutes left" and then stop saying
// anything, without a poll and without the server having to announce an
// absence.

import type { ServerNotice } from '@/types/protocol';

/** The notice if it is still standing at `now`, or null. */
export const standingNotice = (
  notice: ServerNotice | null | undefined,
  now: number,
): ServerNotice | null => {
  if (!notice?.text) return null;
  // A notice with no expiry on it stands until it is taken down. The server
  // always sets one, so this is about an older build rather than a real state —
  // and treating an absent deadline as "expired" would hide a live notice,
  // which is the failure this whole file exists to prevent.
  if (!notice.expiresAtUnixMs) return notice;
  return notice.expiresAtUnixMs > now ? notice : null;
};

/**
 * How long a standing notice has left, in the units somebody reads it in.
 *
 * Coarse on purpose, and it rounds *up*: a host deciding whether to take a
 * notice down is better served by "1 minute left" than by "0 minutes left" on
 * something still in front of every player.
 */
export const noticeRemaining = (notice: ServerNotice, now: number): string => {
  if (!notice.expiresAtUnixMs) return 'until you take it down';
  const minutes = Math.ceil((notice.expiresAtUnixMs - now) / 60_000);
  if (minutes <= 1) return 'under a minute left';
  if (minutes < 60) return `${minutes} minutes left`;
  const hours = Math.round(minutes / 60);
  return hours === 1 ? 'about an hour left' : `about ${hours} hours left`;
};
