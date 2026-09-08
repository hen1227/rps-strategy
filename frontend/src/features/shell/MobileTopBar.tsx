import { usePathname } from 'expo-router';
import { Image, StyleSheet, Text, View } from 'react-native';

import { sectionForPath } from './sections';
import { liveHeadline } from '@/features/live/liveSelectors';
import { useLiveSnapshot } from '@/features/live/useLiveSnapshot';
import { useGameStore } from '@/store/gameStore';
import { colors, space, type } from '@/theme';

// The phone's header.
//
// One line, because a phone has no room for more and the tab bar below already
// says which section is open. What it adds is the two things the sidebar carries
// on a desktop and nothing carried on a phone: the mark, so a page looks like
// this site, and whether the socket is actually connected — which matters here,
// because half of what the lobby shows is live.
//
// The connection state also carries the room, now that the phone has no rail
// and no strip above the tab bar. Connected, the dot is the socket and the line
// beside it is the count the rail puts in its own header; disconnected, the
// counts are the last thing that was true rather than what is, so the line says
// so instead of quoting them. Nothing here opens anything: the boards behind
// these numbers are on the lobby, one tap away in the bar below.

export default function MobileTopBar() {
  const pathname = usePathname();
  const connectionStatus = useGameStore((state) => state.connectionStatus);
  const isConnected = connectionStatus === 'connected';
  const section = sectionForPath(pathname);
  const snapshot = useLiveSnapshot();

  return (
    <View style={styles.bar}>
      <View style={styles.brand}>
        <Image
          source={require('../../../assets/pieces/blue_rock.png')}
          style={styles.brandIcon}
          resizeMode="contain"
          accessibilityLabel="Blue rock"
        />
        {/* <Text style={styles.brandName}>Stoneplay</Text> */}
      </View>
      {/* The tab bar names the four sections it holds; this names the others. */}
      {section && !section.primary ? (
        <Text numberOfLines={1} style={styles.section}>
          {section.label}
        </Text>
      ) : (
        <View style={styles.spacer} />
      )}
      <View style={styles.status}>
        <View style={[styles.dot, isConnected ? styles.dotOnline : styles.dotOffline]} />
        <Text numberOfLines={1} style={styles.statusText}>
          {isConnected ? liveHeadline(snapshot).toUpperCase() : 'CONNECTING'}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.small,
    minHeight: 40,
    paddingHorizontal: space.large,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    backgroundColor: colors.surfaceSunken,
  },
  brand: { flexDirection: 'row', alignItems: 'center', gap: space.small },
  brandIcon: { width: 32, height: 32 },
  brandName: { ...type.bodyStrong, color: colors.accentBright, fontWeight: '900' },
  spacer: { flex: 1 },
  // `minWidth: 0` so a long section name ellipsises and gives way to the live
  // line, rather than pushing it off the end of the bar: a flex item will not
  // shrink below its longest word without it.
  section: {
    ...type.label,
    flex: 1,
    minWidth: 0,
    color: colors.textSubtle,
    letterSpacing: 0.6,
  },
  status: { flexDirection: 'row', alignItems: 'center', flexShrink: 1, gap: space.tight },
  dot: { width: 6, height: 6, borderRadius: 3 },
  dotOnline: { backgroundColor: colors.accent },
  dotOffline: { backgroundColor: colors.textFaint },
  statusText: { ...type.eyebrow, color: colors.textFaint, letterSpacing: 0.8 },
});
