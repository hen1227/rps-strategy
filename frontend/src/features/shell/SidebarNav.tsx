import { Link, usePathname } from 'expo-router';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { visibleSections } from './sections';
import TournamentPromoLink from './TournamentPromoLink';
import {links, webGoatGuy} from '@/navigation/links';
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
            section.path === pathname;
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
          Only in the days around the event, and nothing at all the rest of the
          year — the component decides that for itself so the two places that
          show it cannot disagree about when. Above the credits link rather than
          below it because it expires: while it is here it is the more urgent of
          the two, and when it goes the foot is what it always was.
        */}
        <TournamentPromoLink />

        {/*
          Where this game came from. This used to be a bare link to one YouTube
          video, labelled "the video behind this game", and that stopped being
          the whole truth: there are two videos, an official site, and a Discord.
          A route rather than an outward link, because the page is what holds
          all four of them.
        */}
        <Link asChild href={links.credits()} replace>
          <Pressable
            accessibilityLabel="Where this game came from"
            accessibilityRole="link"
            // One resolved style object: see the note above.
            style={styles.video}
          >
            <Text style={styles.videoText}>Learn more about this game</Text>
          </Pressable>
        </Link>

          <Link asChild href={webGoatGuy.discordURL} replace>
              <Pressable
                  accessibilityLabel="Where this game came from"
                  accessibilityRole="link"
                  // One resolved style object: see the note above.
                  style={styles.discord}
              >
                  <Text style={styles.videoText}>Official Intransitive Discord</Text>
              </Pressable>
          </Link>

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
    discord: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.snug,
    minHeight: 34,
    paddingHorizontal: space.small,
    borderRadius: radius.medium,
    borderWidth: 1,
    borderColor: colors.discordBorder,
    backgroundColor: colors.discordSurface,
  },
  discordMark: { color: colors.accentSoft, fontSize: 10 },
  discordText: { ...type.label, color: colors.textSubtle, letterSpacing: 0.4 },
  policy: { ...type.meta, color: colors.textFaint, paddingHorizontal: space.small },
});
