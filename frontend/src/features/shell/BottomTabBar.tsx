import { Link, usePathname } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { visibleSections } from './sections';
import { links } from '@/navigation/links';
import { useGameStore } from '@/store/gameStore';
import { colors, space, type } from '@/theme';

// The phone's navigation.
//
// Seven sections do not fit across a phone, and a horizontally scrolling strip
// hides the ones off the edge without admitting it. Four permanent tabs and a
// More tab is the honest split: the four are what somebody opens repeatedly,
// and More is a list that says out loud that there is more.

export default function BottomTabBar() {
  const pathname = usePathname();
  const account = useGameStore((state) => state.account);
  const sections = visibleSections(account);
  const primary = sections.filter((section) => section.primary);
  // More is current whenever the page on screen is not one of the four tabs,
  // which is how a section reached through it stays visibly "under" More.
  const onMore =
    pathname === '/more' ||
    !primary.some((section) =>
      section.path === '/' ? pathname === '/' : pathname.startsWith(section.path),
    );

  return (
    <View style={styles.bar}>
      {primary.map((section) => {
        const current =
          section.path === '/' ? pathname === '/' : pathname.startsWith(section.path);
        return (
          <Link asChild href={section.href} key={section.id} replace>
            <Pressable
              accessibilityLabel={section.label}
              accessibilityRole="link"
              accessibilityState={{ selected: current }}
              // See the note in SidebarNav: `Link asChild` takes one resolved
              // style object and silently drops anything else.
              style={styles.tab}
            >
              <View style={[styles.marker, current && styles.markerCurrent]} />
              <Text style={[styles.label, current && styles.labelCurrent]}>
                {section.shortLabel ?? section.label}
              </Text>
            </Pressable>
          </Link>
        );
      })}
      <Link asChild href={links.more()} replace>
        <Pressable
          accessibilityLabel="More sections"
          accessibilityRole="link"
          accessibilityState={{ selected: onMore }}
          style={styles.tab}
        >
          <View style={[styles.marker, onMore && styles.markerCurrent]} />
          <Text style={[styles.label, onMore && styles.labelCurrent]}>More</Text>
        </Pressable>
      </Link>
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
