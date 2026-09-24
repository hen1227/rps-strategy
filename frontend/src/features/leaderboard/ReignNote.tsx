// How long the engine in front has been in front, and who used to be.
//
// Two readings of one ledger, drawn in one place so the ladder and a bot's page
// cannot round the same reign differently. See `bot_reigns.go` for what a reign
// is and why it is not a title.
//
// Reigns are recorded only from the day the ledger shipped, which is why
// nothing here says "never" or "first": an engine with no reign on record may
// simply have led before anybody was counting, and a board that claimed
// otherwise would be making up history it does not have.

import { Text } from 'react-native';

import { useNow } from '@/hooks/useNow';
import { colors, themedSheet, type } from '@/theme';
import { formatSpan } from '@/ui/duration';
import { Badge } from '@/ui/primitives';
import type { LeaderboardEntry } from '@/types/protocol';

export interface ReignNoteProps {
  entry: LeaderboardEntry;
  /** Bot rows only. A person has no reign, so asking would always be nothing. */
  isBot: boolean;
}

/**
 * "#1 for 24 days" under the leader, and a quiet mark on an engine that used to
 * be one.
 *
 * `useNow` is called before anything is decided, because a hook that runs only
 * on some rows is a different and louder bug than the one it would be trying to
 * avoid. It returns null until the first client render has settled, which is
 * also exactly what the pre-rendered HTML contains — a duration cannot be baked
 * into a static page, because the page would then claim the reign stopped
 * growing on the day of the build.
 */
export default function ReignNote({ entry, isBot }: ReignNoteProps) {
  const now = useNow();
  if (!isBot) return null;

  const since = entry.leadingSinceUnixMs;
  if (since) {
    // Before the clock settles, say the true half that needs no arithmetic.
    // "#1" alone is right in both renders, so the row does not change shape
    // when the duration arrives.
    return (
      <Text numberOfLines={1} style={styles.reign}>
        {now === null ? '#1' : `#1 for ${formatSpan(since, now)}`}
      </Text>
    );
  }
  if (entry.heldTopSeat) return <Badge label="EX-#1" tone="cool" />;
  return null;
}

const styles = themedSheet(() => ({
  reign: { ...type.meta, color: colors.goldBright, fontWeight: '700' },
}));
