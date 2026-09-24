import { Link } from 'expo-router';
import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View, type ViewStyle } from 'react-native';

import ReignNote from './ReignNote';
import { RecordSummary, ladderRecord } from './ladderRecord';
import BotIcon from '@/features/bots/BotIcon';
import { links } from '@/navigation/links';
import { botIconUrl } from '@/store/api/bots';
import type { LeaderboardKind } from '@/store/api/leaderboard';
import { colors, podium, radius, space, themedSheet, type } from '@/theme';
import Monogram from '@/ui/Monogram';
import TitleTag from '@/ui/TitleTag';
import { Badge } from '@/ui/primitives';
import type { LeaderboardEntry } from '@/types/protocol';

// The top of one board, as three cards.
//
// The rows below already say who is first, so this is not information the page
// was missing — it is the answer to the question the page is *for*, given the
// space that question deserves. A ladder whose first line is the same twelve
// pixels as its fortieth makes the reader do the work of noticing.
//
// Only ever three, and only ever the real top three. A board with two rows on it
// draws two cards rather than a card and two empty plinths, because a plinth
// with nobody on it is a claim that somebody is missing.
//
// Two layouts, and the narrow one is not the wide one stacked. Three of the wide
// card in a column is fourteen hundred points of podium before the fourth-placed
// row, which is a phone screen and a half spent on three names; the narrow card
// turns on its side instead and keeps the medal, the colour and the record while
// costing about as much room as two ordinary rows.
//
// Whole cards are links, for the same reason `LadderRows` makes whole rows
// links: a name on a ladder is an address, and hunting for a small button beside
// it is a step nobody wants. That is also why there is no button on the card —
// an anchor inside an anchor is not a thing the web has an answer for.

/** How many cards a podium is. Not a setting; it is what "podium" means. */
export const PODIUM_SIZE = 3;

export interface LadderPodiumProps {
  /** The whole board. The first three of it are taken here. */
  entries: LeaderboardEntry[];
  kind: LeaderboardKind;
  highlightUserId?: string;
  /** Three across, first in the middle and raised. Turned on their side when false. */
  wide?: boolean;
}

export default function LadderPodium({
  entries,
  highlightUserId,
  kind,
  wide = false,
}: LadderPodiumProps) {
  const top = entries.slice(0, PODIUM_SIZE);
  if (top.length === 0) return null;

  // Second, first, third — a real podium, with the winner in the middle. React
  // Native has no `order`, so the order is the array's. Stacked, it stays 1-2-3:
  // a column reads top to bottom and putting second above first there would be
  // a puzzle rather than a shape.
  const arranged = wide && top.length === PODIUM_SIZE ? [top[1], top[0], top[2]] : top;

  return (
    <View style={[styles.podium, wide && styles.podiumWide]}>
      {arranged.map((entry) =>
        wide ? (
          <TallCard
            entry={entry}
            key={entry.userId}
            kind={kind}
            you={entry.userId === highlightUserId}
          />
        ) : (
          <FlatCard
            entry={entry}
            key={entry.userId}
            kind={kind}
            you={entry.userId === highlightUserId}
          />
        ),
      )}
    </View>
  );
}

interface CardProps {
  entry: LeaderboardEntry;
  kind: LeaderboardKind;
  you: boolean;
}

/**
 * What both cards work out the same way.
 *
 * A board can be paged, so rank 1 is not guaranteed to be the first row shown —
 * but a podium only ever draws the first page's first three, and the medal is
 * the rank rather than the position in the array so that stays true if that
 * ever changes.
 */
const dress = (entry: LeaderboardEntry) => ({
  tone: podium[entry.rank - 1] ?? podium[podium.length - 1],
  result: ladderRecord(entry),
  isFirst: entry.rank === 1,
});

/** Who to talk to about this engine, and which build the record belongs to. */
function Byline({ entry, kind }: { entry: LeaderboardEntry; kind: LeaderboardKind }) {
  // Only on the bot board, and only when the server sent it: an older server
  // has no such field, and "by —" would be the card inventing a gap.
  if (kind !== 'bot' || !entry.ownerUsername) return null;
  return (
    <Text numberOfLines={1} style={styles.byline}>
      by {entry.ownerUsername}
      {entry.engineName ? ` · ${entry.engineName}` : ''}
    </Text>
  );
}

function Portrait({
  entry,
  kind,
  size,
}: {
  entry: LeaderboardEntry;
  kind: LeaderboardKind;
  size: number;
}) {
  return kind === 'bot' ? (
    <BotIcon name={entry.username} size={size} uri={botIconUrl(entry.userId, entry.iconSha256)} />
  ) : (
    <Monogram name={entry.username} round size={size} />
  );
}

/** The pressable shell both cards share, so only one of them knows about `Link`. */
function CardShell({
  entry,
  children,
  style,
}: {
  entry: LeaderboardEntry;
  children: ReactNode;
  style: ViewStyle;
}) {
  return (
    <Link asChild href={links.player(entry.username)}>
      <Pressable
        accessibilityLabel={`Open ${entry.username}'s page`}
        accessibilityRole="link"
        // One resolved style object: `Link asChild` clones this into a real
        // anchor, and an array reaches the DOM node as something with numeric
        // keys and throws on the way in. See the longer note in `GhostLink`.
        style={style}
      >
        {children}
      </Pressable>
    </Link>
  );
}

/** The wide card: a plinth, with the winner's standing higher than the others'. */
function TallCard({ entry, kind, you }: CardProps) {
  const { tone, result, isFirst } = dress(entry);
  return (
    <CardShell
      entry={entry}
      style={StyleSheet.flatten([
        styles.card,
        styles.tall,
        { borderColor: tone.border, backgroundColor: tone.surface },
        isFirst && styles.tallFirst,
      ])}
    >
      <View style={styles.medalRow}>
        <Text style={[styles.medal, { color: tone.text }]}>{entry.rank}</Text>
        {you ? <Badge label="YOU" tone="accent" /> : null}
      </View>
      <Portrait entry={entry} kind={kind} size={isFirst ? 64 : 52} />
      <View style={styles.nameRow}>
        <TitleTag size="medium" title={entry.title} />
        <Text numberOfLines={1} style={styles.name}>
          {entry.username}
        </Text>
      </View>
      <Text style={[styles.elo, isFirst && styles.eloFirst]}>{entry.elo}</Text>
      <Byline entry={entry} kind={kind} />
      <ReignNote entry={entry} isBot={kind === 'bot'} />
      <RecordSummary result={result} />
    </CardShell>
  );
}

/** The narrow card: the same three facts across one line and a bit. */
function FlatCard({ entry, kind, you }: CardProps) {
  const { tone, result } = dress(entry);
  return (
    <CardShell
      entry={entry}
      style={StyleSheet.flatten([
        styles.card,
        styles.flat,
        { borderColor: tone.border, backgroundColor: tone.surface },
      ])}
    >
      <Text style={[styles.medal, styles.flatMedal, { color: tone.text }]}>{entry.rank}</Text>
      <Portrait entry={entry} kind={kind} size={40} />
      {/* `minWidth: 0` is what lets a long engine name truncate rather than
          pushing the rating off the right edge of the card. */}
      <View style={styles.flatCopy}>
        <View style={styles.nameRow}>
          <TitleTag title={entry.title} />
          <Text numberOfLines={1} style={styles.flatName}>
            {entry.username}
          </Text>
          {you ? <Badge label="YOU" tone="accent" /> : null}
        </View>
        <Byline entry={entry} kind={kind} />
        <ReignNote entry={entry} isBot={kind === 'bot'} />
        <RecordSummary result={result} />
      </View>
      <Text style={styles.flatElo}>{entry.elo}</Text>
    </CardShell>
  );
}

const styles = themedSheet(() => ({
  podium: { gap: space.small, marginTop: space.medium },
  // Bottoms aligned, so the first card standing up out of the row is what makes
  // it a podium — rather than three equal cards with a colour difference.
  podiumWide: { flexDirection: 'row', alignItems: 'flex-end', gap: space.medium },

  card: {
    borderWidth: 1,
    borderRadius: radius.large,
    padding: space.medium,
  },

  // `flexBasis: 0` with `minWidth: 0`, so a long engine name truncates instead
  // of widening its own card and squeezing the other two.
  tall: { flex: 1, flexBasis: 0, minWidth: 0, gap: space.snug, alignItems: 'center' },
  tallFirst: { paddingVertical: space.large },

  flat: { flexDirection: 'row', alignItems: 'center', gap: space.medium },
  flatMedal: { minWidth: 16, textAlign: 'center' },
  flatCopy: { flex: 1, minWidth: 0, gap: space.tight },
  flatName: { ...type.rowTitle, color: colors.textStrong, flexShrink: 1 },
  flatElo: { ...type.cardTitle, color: colors.textStrong, minWidth: 46, textAlign: 'right' },

  medalRow: { flexDirection: 'row', alignItems: 'center', gap: space.snug },
  medal: { ...type.sectionTitle, lineHeight: 20 },

  nameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.snug,
    maxWidth: '100%',
    minWidth: 0,
  },
  name: { ...type.cardTitle, color: colors.textStrong, flexShrink: 1 },

  elo: { ...type.hero, color: colors.text },
  eloFirst: { color: colors.textStrong },

  byline: { ...type.meta, color: colors.textDim },
}));
