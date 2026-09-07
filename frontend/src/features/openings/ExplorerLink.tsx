// The door from the book to the explorer.
//
// These two pages answer different questions about the same tree -- what is
// good, and what happens -- and the interesting thing is the gap between them.
// So this is not a bare link: it carries the one number that makes somebody
// want to click, and it carries the line they are standing on, so they arrive
// on the board they were already looking at rather than at the start.

import { useRouter } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import {
  formatShare,
  hasEnoughGames,
  type OpeningStatsNode,
} from '@/engine/openingStats';
import { links } from '@/navigation/links';
import { colors, radius, space } from '@/theme';
import type { ModeID } from '@/types/game';
import { Badge, Panel } from '@/ui/primitives';

import { ui } from './openingsUi';

export interface ExplorerLinkProps {
  /** The line the book is standing on, so the explorer opens on it too. */
  line: string[];
  modeId: ModeID;
  /** The mode's condensed statistics, for the teaser. Null while loading. */
  stats: OpeningStatsNode | null;
}

export default function ExplorerLink({ line, modeId, stats }: ExplorerLinkProps) {
  const router = useRouter();
  const top = stats?.continuations?.[0];

  // The teaser only makes a claim it can support. Below a handful of games a
  // percentage is a count wearing a percent sign, so it names the move
  // instead; with no games at all it says what the page is for.
  const teaser = !stats
    ? 'See what people actually play from any position.'
    : stats.games === 0
      ? 'No games have been counted yet — the explorer fills in as they are played.'
      : top && hasEnoughGames(stats.games)
        ? `${formatShare(top.share)} of the ${stats.games.toLocaleString()} games counted open ${top.move}.`
        : top
          ? `${stats.games} game${stats.games === 1 ? '' : 's'} counted so far; the commonest first move is ${top.move}.`
          : `${stats.games} game${stats.games === 1 ? '' : 's'} counted.`;

  return (
    <Pressable
      accessibilityHint="Opens the opening explorer on this position."
      accessibilityLabel="Open the opening explorer"
      accessibilityRole="link"
      onPress={() => router.push(links.explorer({ mode: modeId, line }))}
      style={({ pressed }) => [pressed && ui.pressed]}
    >
      <Panel style={styles.panel} tone="accent">
        <View style={styles.copy}>
          <Text style={ui.eyebrow}>WHAT PEOPLE PLAY</Text>
          <Text style={styles.title}>Opening explorer</Text>
          <Text style={styles.detail}>{teaser}</Text>
          <Text style={styles.hint}>
            A board you can move pieces on. It answers for the position rather than the move
            order, so two ways to the same board share one set of numbers.
          </Text>
        </View>
        <View style={styles.action}>
          <Badge
            label={line.length > 0 ? `OPEN ON THIS LINE →` : 'OPEN THE EXPLORER →'}
            tone="accent"
          />
        </View>
      </Panel>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  panel: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: space.medium,
    justifyContent: 'space-between',
  },
  // `minWidth: 0` so a long teaser wraps rather than pushing the badge off the
  // row: a flex item will not shrink below its longest word without it.
  copy: { flex: 1, gap: 3, minWidth: 0 },
  title: { color: colors.text, fontSize: 19, fontWeight: '700' },
  detail: { color: colors.text, fontSize: 13, lineHeight: 19 },
  hint: { color: colors.textMuted, fontSize: 11, lineHeight: 16 },
  action: { alignItems: 'flex-end', borderRadius: radius.small },
});
