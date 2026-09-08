import { Link, usePathname } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Dimensions, Pressable, StyleSheet, Text, View } from 'react-native';

import MoreMenu, { type MoreAnchor } from './MoreMenu';
import { visibleSections } from './sections';
import { useGameStore } from '@/store/gameStore';
import { colors, space, type } from '@/theme';

// The phone's navigation.
//
// Seven sections do not fit across a phone, and a horizontally scrolling strip
// hides the ones off the edge without admitting it. Four permanent tabs and a
// More tab is the honest split: the four are what somebody opens repeatedly,
// and More is the rest — a menu that opens upwards over the bar rather than a
// page you have to travel to and back from. See `MoreMenu`.

export default function BottomTabBar() {
  const pathname = usePathname();
  const account = useGameStore((state) => state.account);
  const sections = visibleSections(account);
  const primary = sections.filter((section) => section.primary);
  const overflow = sections.filter((section) => !section.primary);
  const [menuOpen, setMenuOpen] = useState(false);
  const [anchor, setAnchor] = useState<MoreAnchor | null>(null);
  const moreTab = useRef<View>(null);

  // More is current whenever the page on screen is not one of the four tabs,
  // which is how a section reached through it stays visibly "under" More.
  const onMore = !primary.some((section) =>
    section.path === '/' ? pathname === '/' : pathname.startsWith(section.path),
  );
  const moreLit = onMore || menuOpen;

  // Every way out of the menu that is not a press on it: the back button, a
  // deep link, the call-out that opens a board.
  useEffect(() => {
    setMenuOpen(false);
  }, [pathname]);

  // Measured at layout rather than on the press, so the menu is already placed
  // the moment it appears — and measured again whenever the bar moves, which is
  // what a rotation, a resize, or a browser's collapsing address bar does.
  const measure = () =>
    moreTab.current?.measureInWindow((x, y, width) =>
      setAnchor({
        bottom: Math.max(0, Dimensions.get('window').height - y),
        caretX: x + width / 2,
      }),
    );

  return (
    <>
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
        <Pressable
          accessibilityHint="Lists the sections without a tab of their own"
          accessibilityLabel="More sections"
          accessibilityRole="button"
          accessibilityState={{ expanded: menuOpen, selected: onMore }}
          onLayout={measure}
          onPress={() => setMenuOpen((open) => !open)}
          ref={moreTab}
          style={styles.tab}
        >
          <View style={[styles.marker, moreLit && styles.markerCurrent]} />
          <Text style={[styles.label, moreLit && styles.labelCurrent]}>More</Text>
        </Pressable>
      </View>

      <MoreMenu
        anchor={anchor}
        onClose={() => setMenuOpen(false)}
        sections={overflow}
        visible={menuOpen}
      />
    </>
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
