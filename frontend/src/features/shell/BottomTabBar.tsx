import { Link, usePathname } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { groupForPath, groupHref, visibleGroups } from './sections';
import { useNavContext } from './useNavContext';
import { colors, space, type } from '@/theme';

// The phone's navigation.
//
// Five tabs and nothing behind them. This used to be four tabs plus a More
// menu, which was an honest answer to a flat list of ten sections but made the
// bar a ranking: Weekend held a permanent tab and the leaderboard was in a
// drawer, because somebody had guessed which was opened more. Grouping removes
// the guess. Every page is now inside one of five groups, so every page is one
// tap and then one more along the strip — see `SubNav` — and nothing is hidden
// behind a menu that has to be discovered first.
//
// The same five, in the same order, are the sidebar's headings on a desktop.
// That is the point of the change rather than a side effect of it: the two
// surfaces used to disagree about what this site contains.

export default function BottomTabBar() {
  const pathname = usePathname();
  const nav = useNavContext();
  const groups = visibleGroups(nav);
  const current = groupForPath(pathname);

  return (
    <View style={styles.bar}>
      {groups.map((group) => {
        const href = groupHref(group.id, nav);
        // `visibleGroups` has already dropped the groups with nowhere to land,
        // so this is narrowing rather than a case that happens.
        if (!href) return null;
        const lit = group.id === current;
        return (
          <Link asChild href={href} key={group.id} replace>
            <Pressable
              accessibilityHint={group.hint}
              accessibilityLabel={group.label}
              accessibilityRole="link"
              accessibilityState={{ selected: lit }}
              // See the note in SidebarNav: `Link asChild` takes one resolved
              // style object and silently drops anything else.
              style={styles.tab}
            >
              <View style={[styles.marker, lit && styles.markerCurrent]} />
              {/*
                One line, always. Every group label is one short word, which is
                what makes that safe — the bar used to render "Weekend Bot
                Tourney" into a 62pt tab and let it wrap to three lines.
              */}
              <Text numberOfLines={1} style={[styles.label, lit && styles.labelCurrent]}>
                {group.label}
              </Text>
            </Pressable>
          </Link>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    alignItems: 'stretch',
    borderTopWidth: 1,
    borderTopColor: colors.border,
    backgroundColor: colors.surfaceSunken,
  },
  tab: {
    flex: 1,
    alignItems: 'stretch',
    gap: space.snug,
    paddingTop: space.snug,
    paddingBottom: space.medium,
  },
  // See the note in SidebarNav: an anchor around a Pressable does not carry the
  // Pressable's alignment, so each tab centres its own pieces.
  marker: {
    width: 22,
    height: 3,
    alignSelf: 'center',
    borderRadius: 2,
    backgroundColor: 'transparent',
  },
  markerCurrent: { backgroundColor: colors.accent },
  label: { ...type.label, alignSelf: 'center', color: colors.textFaint, letterSpacing: 0.4 },
  labelCurrent: { color: colors.textStrong },
});
