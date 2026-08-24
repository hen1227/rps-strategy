// How long ago, in as few characters as will do.
//
// Pulled out of the bot match history when the feed replaced it: the feed, the
// cards inside it and the strip over the board all date the same occasions, and
// three copies of this would be three chances for one of them to round "just
// now" differently from the row above it.
export const relativeTime = (unixMs: number) => {
  const seconds = Math.max(0, Math.round((Date.now() - unixMs) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(unixMs).toLocaleDateString();
};
