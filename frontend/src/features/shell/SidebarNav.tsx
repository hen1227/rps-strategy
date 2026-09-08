import { Link, usePathname } from 'expo-router';
import { Image, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { sectionForPath, sectionsInGroup, visibleGroups } from './sections';
import { useNavContext } from './useNavContext';
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
//
// Two levels now, and the same two the phone shows: five headings, each with
// its pages under it. The flat list this replaced was not wrong so much as
// unshared — the phone could only fit four of its ten rows and put the rest in
// a menu, so the two surfaces described the site differently. Grouping is what
// lets both render the same list. Every row here is a chip on the phone's
// strip, in this order.

const BrandMark = () => (
  <View style={styles.brand}>
    <Image
      source={require('../../../assets/pieces/blue_rock.png')}
      style={styles.brandIcon}
      resizeMode="contain"
      accessibilityLabel="Blue rock"
    />
    {/* <Text style={styles.brandName}>Stoneplay</Text> */}
  </View>
);

export default function SidebarNav() {
  const pathname = usePathname();
  const connectionStatus = useGameStore((state) => state.connectionStatus);
  const isConnected = connectionStatus === 'connected';
  // The identity row reads the account out of here too, rather than selecting
  // it a second time: the foot and the list should never be able to disagree
  // about who is signed in.
  const nav = useNavContext();
  const { account } = nav;
  const groups = visibleGroups(nav);
  // Which row is lit, by path rather than by href: `/account/bots/connect` is
  // the Connect page even though three sections' paths are prefixes of it.
  const current = sectionForPath(pathname);

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
        {groups.map((group) => (
          <View key={group.id} style={styles.group}>
            {/*
              A heading rather than a link. The group is the five pages under
              it; pressing the word would have to mean one of them, and picking
              which is the guess this arrangement exists to remove. The phone's
              tab has to land somewhere and does — see `groupHref` — but here
              there is room to show the children instead of choosing for
              somebody.
            */}
            <Text style={styles.groupLabel}>{group.label}</Text>
            {sectionsInGroup(group.id, nav).map((section) => {
              const lit = section.id === current?.id;
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
                    accessibilityState={{ selected: lit }}
                    style={StyleSheet.flatten([styles.item, lit && styles.itemCurrent])}
                  >
                    <View style={[styles.marker, lit && styles.markerCurrent]} />
                    <Text style={[styles.itemLabel, lit && styles.itemLabelCurrent]}>
                      {section.label}
                    </Text>
                    {/* Leaves the shell, and this column with it. See `SubNav`. */}
                    {section.external ? <Text style={styles.away}>↗</Text> : null}
                  </Pressable>
                </Link>
              );
            })}
          </View>
        ))}
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
          Where this game came from is now a row in the list above, under You,
          because a phone had no other way to reach it once the More menu went.
          What stays down here is the one link that is not a page of this site
          and so cannot be a section: somebody else's Discord.
        */}
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
  brand: { flexDirection: 'row', alignItems: 'center', gap: space.small },
  brandIcon: { width: 40, height: 40 },
  brandName: { ...type.cardTitle, color: colors.accentBright, letterSpacing: 0.5 },
  status: { flexDirection: 'row', alignItems: 'center', gap: space.snug },
  dot: { width: 7, height: 7, borderRadius: 4 },
  dotOnline: { backgroundColor: colors.accent },
  dotOffline: { backgroundColor: colors.textFaint },
  statusText: { ...type.eyebrow, color: colors.textMuted, letterSpacing: 0.8 },

  list: { flex: 1 },
  group: { marginBottom: space.small },
  groupLabel: {
    ...type.eyebrow,
    color: colors.textFaint,
    paddingHorizontal: space.snug,
    marginBottom: space.hair,
  },
  item: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.small,
    minHeight: 34,
    paddingLeft: space.small,
    paddingRight: space.snug,
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
  away: { ...type.meta, color: colors.textFaint },

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
});
