import { Pressable, Text, View } from 'react-native';

import VoteButton from './VoteButton';
import { timeAgo } from './relativeTime';
import { statusTone } from './statusTone';
import { colors, radius, space, themedSheet, type } from '@/theme';
import { Badge } from '@/ui/primitives';
import type { FeedbackItem } from '@/types/protocol';

// One row of the board.
//
// A card rather than a table row, for the reason `ListRow`'s own note gives
// about the engine roster: these are things to read rather than fields to scan
// down a column. A bug report is a sentence and a half, and the second half —
// what the host said about it — is the part somebody came to find.
//
// The whole card is the target rather than the title. On a phone a tappable
// title inside an untappable card is a 12-point target inside a 70-point one,
// and the difference is invisible until you miss it.

export interface FeedbackCardProps {
  item: FeedbackItem;
  now: number | null;
  onOpen: () => void;
  /** Absent when this visitor may not vote; the refusal says why. */
  onVote?: (() => void) | null;
  voteRefusal?: string;
}

export default function FeedbackCard({
  item,
  now,
  onOpen,
  onVote,
  voteRefusal,
}: FeedbackCardProps) {
  const tone = statusTone(item.status);
  return (
    <View style={[styles.card, item.pinned && styles.cardPinned]}>
      <VoteButton
        onPress={onVote}
        refusal={voteRefusal}
        title={item.title}
        votes={item.votes}
        youVoted={item.youVoted}
      />
      <Pressable
        accessibilityHint="Opens the thread"
        accessibilityRole="button"
        onPress={onOpen}
        // `minWidth: 0` is what lets the title wrap instead of pushing the vote
        // button off the card: a flex child's default minimum is its content.
        style={({ pressed }) => [styles.copy, pressed && styles.pressed]}
      >
        <View style={styles.badges}>
          {/*
            The same word the tab, the button and the thread use. "Idea" fits
            the chip better and is a third name for one thing, which is how a
            reader ends up wondering whether it is a different thing.
          */}
          <Badge
            label={item.kind === 'bug' ? 'BUG' : 'SUGGESTION'}
            tone={item.kind === 'bug' ? 'warm' : 'cool'}
          />
          {tone ? <Badge label={item.statusLabel.toUpperCase()} tone={tone} /> : null}
          {item.pinned ? <Badge label="PINNED" tone="gold" /> : null}
          {item.hidden ? <Badge label="HIDDEN" tone="neutral" /> : null}
        </View>
        <Text numberOfLines={2} style={styles.title}>
          {item.title}
        </Text>
        {item.statusNote ? (
          // Above the byline rather than below the body: it is the answer, and
          // the answer is what somebody scanning the board is looking for.
          <Text numberOfLines={2} style={styles.note}>
            {item.statusNote}
          </Text>
        ) : null}
        <Text numberOfLines={1} style={styles.meta}>
          {[
            item.fromHost ? `${item.authorName} (host)` : item.authorName,
            now === null ? null : timeAgo(item.createdAtUnixMs, now),
            item.comments > 0
              ? `${item.comments} ${item.comments === 1 ? 'reply' : 'replies'}`
              : null,
          ]
            .filter(Boolean)
            .join(' · ')}
        </Text>
      </Pressable>
    </View>
  );
}

const styles = themedSheet(() => ({
  card: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: space.medium,
    padding: space.medium,
    borderRadius: radius.large,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  cardPinned: { borderColor: colors.goldBorder, backgroundColor: colors.goldSurfaceDeep },
  copy: { flex: 1, minWidth: 0, gap: space.tight },
  pressed: { opacity: 0.75 },
  badges: { flexDirection: 'row', flexWrap: 'wrap', gap: space.tight },
  title: { ...type.rowTitle, color: colors.textStrong, fontSize: 13, lineHeight: 18 },
  note: { ...type.body, color: colors.accentText },
  meta: { ...type.meta, color: colors.textFaint },
}));
