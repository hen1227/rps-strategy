// "3 days ago", for a board where the age of a thing is most of its meaning.
//
// A bug reported this morning and one reported last spring are read completely
// differently, and an absolute timestamp makes the reader do that arithmetic on
// every row. Kept here rather than in `@/ui` because it is the only place that
// wants this shape: the rest of the app shows dates, clocks or move numbers.
//
// Coarse on purpose. Past a week the exact day stops mattering and the wrong
// impression to give is precision.

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export const timeAgo = (unixMs: number, now: number): string => {
  const elapsed = Math.max(0, now - unixMs);
  if (elapsed < MINUTE) return 'just now';
  if (elapsed < HOUR) {
    const minutes = Math.floor(elapsed / MINUTE);
    return `${minutes}m ago`;
  }
  if (elapsed < DAY) {
    const hours = Math.floor(elapsed / HOUR);
    return `${hours}h ago`;
  }
  const days = Math.floor(elapsed / DAY);
  if (days < 7) return `${days}d ago`;
  if (days < 60) return `${Math.floor(days / 7)}w ago`;
  return `${Math.floor(days / 30)}mo ago`;
};
