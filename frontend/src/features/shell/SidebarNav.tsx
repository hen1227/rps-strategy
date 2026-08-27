import { Link, usePathname } from 'expo-router';
import { Linking, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { visibleSections } from './sections';
import { links, YOUTUBE_URL } from '@/navigation/links';
import { useGameStore } from '@/store/gameStore';
import { colors, radius, space, type } from '@/theme';

// The desktop navigation.
//
// This is the job the lobby's top bar was quietly doing for the whole app: it
// was the only global navigation anywhere, it only existed on one page, and
// every other screen answered the question with its own back button pointing
// somewhere slightly different. A column that is always there answers it once.

const BrandMark = () => (
  <View style={styles.brand}>
    <Text style={styles.brandLetter}>R</Text>
    <Text style={styles.brandSlash}>/</Text>
    <Text style={styles.brandLetter}>P</Text>
    <Text style={styles.brandSlash}>/</Text>
    <Text style={styles.brandLetter}>S</Text>
  </View>
);

export default function SidebarNav() {
  const pathname = usePathname();
  const account = useGameStore((state) => state.account);
  const connectionStatus = useGameStore((state) => state.connectionStatus);
  const isConnected = connectionStatus === 'connected';
  const sections = visibleSections(account);

  return (
    <View style={styles.sidebar}>
      <View style={styles.head}>
        <BrandMark />
        <View style={styles.status}>
          <View style={[styles.dot, isConnected ? styles.dotOnline : styles.dotOffline]} />
          <Text style={styles.statusText}>{isConnected ? 'ONLINE' : 'CONNECTING'}</Text>
        </View>
      </View>

      <ScrollView showsVerticalScrollIndicator={false} style={styles.list}>
        {sections.map((section) => {
          // `/` would otherwise prefix-match every page, so the front page is
          // current only when it is exactly the front page.
          const current =
            section.path === '/' ? pathname === '/' : pathname.startsWith(section.path);
          return (
            // `StyleSheet.flatten`, and not the usual `({ pressed }) => [...]`
            // function or even a plain array. `Link asChild` clones this child
            // into a real anchor and accepts only one resolved style object;
            // anything else is dropped, which left the row with none of these
            // styles and the current-page marker pinned above its own label
            // instead of beside it. A real `<a href>` is worth keeping —
            // middle-click, copy-link, crawlers — so the press feedback goes.
            <Link asChild href={section.href} key={section.id} replace>
              <Pressable
                accessibilityLabel={section.label}
                accessibilityRole="link"
                accessibilityState={{ selected: current }}
                style={StyleSheet.flatten([styles.item, current && styles.itemCurrent])}
              >
                <View style={[styles.marker, current && styles.markerCurrent]} />
                <Text style={[styles.itemLabel, current && styles.itemLabelCurrent]}>
                  {section.label}
                </Text>
              </Pressable>
            </Link>
          );
        })}
      </ScrollView>

      <View style={styles.foot}>
        {account ? (
          <Link asChild href={links.account()} replace>
            <Pressable
              accessibilityLabel="Your account"
              accessibilityRole="link"
              style={styles.identity}
            >
              <Text numberOfLines={1} style={styles.identityName}>
                {account.username}
              </Text>
              <Text style={styles.identityMeta}>
                {account.elo} ELO · {account.gamesPlayed} games
              </Text>
            </Pressable>
          </Link>
        ) : null}

        {/*
          The video this whole game came out of. An outward link rather than a
          route, so it opens where links open rather than inside the app.
        */}
        <Pressable
          accessibilityLabel="Watch the video this game is based on"
          accessibilityRole="link"
          onPress={() => Linking.openURL(YOUTUBE_URL)}
          style={({ pressed }) => [styles.video, pressed && styles.pressed]}
        >
          <Text style={styles.videoMark}>▶</Text>
          <Text style={styles.videoText}>The video behind this game</Text>
        </Pressable>

        <Link href={links.policy()} replace style={styles.policy}>
          Privacy & play agreement
        </Link>
      </View>
    </View>
  );
}

export const SIDEBAR_WIDTH = 232;

const styles = StyleSheet.create({
  sidebar: {
    width: SIDEBAR_WIDTH,
    alignSelf: 'stretch',
    paddingVertical: space.large,
    paddingHorizontal: space.medium,
    borderRightWidth: 1,
    borderRightColor: colors.border,
    backgroundColor: colors.surfaceSunken,
  },
  head: { gap: space.small, paddingHorizontal: space.snug, marginBottom: space.large },
  brand: { flexDirection: 'row', alignItems: 'center' },
  brandLetter: { ...type.cardTitle, color: colors.accentBright, letterSpacing: 0.5 },
  brandSlash: { color: colors.textFaint, fontSize: 12, fontWeight: '700', marginHorizontal: 3 },
  status: { flexDirection: 'row', alignItems: 'center', gap: space.snug },
  dot: { width: 7, height: 7, borderRadius: 4 },
  dotOnline: { backgroundColor: colors.accent },
  dotOffline: { backgroundColor: colors.textFaint },
  statusText: { ...type.eyebrow, color: colors.textMuted, letterSpacing: 0.8 },

  list: { flex: 1 },
  item: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.small,
    minHeight: 38,
    paddingHorizontal: space.snug,
    borderRadius: radius.medium,
  },
  itemCurrent: { backgroundColor: colors.accentSurfaceQuiet },
  // `alignSelf` rather than relying on the row's `alignItems`: `Link asChild`
  // renders this row as an anchor on the web, which does not carry the
  // Pressable's cross-axis alignment through, and the marker ended up pinned to
  // the top of the row instead of beside its label.
  marker: {
    width: 3,
    height: 16,
    alignSelf: 'center',
    borderRadius: 2,
    backgroundColor: 'transparent',
  },
  markerCurrent: { backgroundColor: colors.accent },
  itemLabel: {
    ...type.bodyStrong,
    flex: 1,
    alignSelf: 'center',
    color: colors.textMuted,
    fontWeight: '800',
  },
  itemLabelCurrent: { color: colors.textStrong },

  foot: { gap: space.small, marginTop: space.medium },
  identity: {
    padding: space.small,
    borderRadius: radius.medium,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  identityName: { ...type.rowTitle, color: colors.textStrong },
  identityMeta: { ...type.meta, color: colors.textFaint, marginTop: space.hair },
  video: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.snug,
    minHeight: 34,
    paddingHorizontal: space.small,
    borderRadius: radius.medium,
    borderWidth: 1,
    borderColor: colors.dangerBorder,
    backgroundColor: colors.dangerSurfaceQuiet,
  },
  videoMark: { color: colors.dangerSoft, fontSize: 10 },
  videoText: { ...type.label, color: colors.textSubtle, letterSpacing: 0.4 },
  policy: { ...type.meta, color: colors.textFaint, paddingHorizontal: space.small },

  pressed: { opacity: 0.7 },
});
