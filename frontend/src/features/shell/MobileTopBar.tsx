import { usePathname } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';

import { sectionForPath } from './sections';
import { useGameStore } from '@/store/gameStore';
import { colors, space, type } from '@/theme';

// The phone's header.
//
// One line, because a phone has no room for more and the tab bar below already
// says which section is open. What it adds is the two things the sidebar carries
// on a desktop and nothing carried on a phone: the mark, so a page looks like
// this site, and whether the socket is actually connected — which matters here,
// because half of what the lobby shows is live.

export default function MobileTopBar() {
  const pathname = usePathname();
  const connectionStatus = useGameStore((state) => state.connectionStatus);
  const isConnected = connectionStatus === 'connected';
  const section = sectionForPath(pathname);

  return (
    <View style={styles.bar}>
      <View style={styles.brand}>
        <Text style={styles.brandLetter}>R</Text>
        <Text style={styles.brandSlash}>/</Text>
        <Text style={styles.brandLetter}>P</Text>
        <Text style={styles.brandSlash}>/</Text>
        <Text style={styles.brandLetter}>S</Text>
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
        <Text style={styles.statusText}>{isConnected ? 'ONLINE' : 'CONNECTING'}</Text>
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
  brand: { flexDirection: 'row', alignItems: 'center' },
  brandLetter: { ...type.bodyStrong, color: colors.accentBright, fontWeight: '900' },
  brandSlash: { color: colors.textFaint, fontSize: 10, fontWeight: '700', marginHorizontal: 2 },
  spacer: { flex: 1 },
  section: { ...type.label, flex: 1, color: colors.textSubtle, letterSpacing: 0.6 },
  status: { flexDirection: 'row', alignItems: 'center', gap: space.tight },
  dot: { width: 6, height: 6, borderRadius: 3 },
  dotOnline: { backgroundColor: colors.accent },
  dotOffline: { backgroundColor: colors.textFaint },
  statusText: { ...type.eyebrow, color: colors.textFaint, letterSpacing: 0.8 },
});
