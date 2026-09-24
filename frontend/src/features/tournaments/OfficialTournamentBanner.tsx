import { Link } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import {
  officialTournament,
  officialTournamentPhase,
  officialTournamentPromoVisible,
  untilLabel,
} from './officialTournament';
import { useNow } from '@/hooks/useNow';
import { links } from '@/navigation/links';
import { colors, radius, space, themedSheet, type } from '@/theme';

// The front page's notice about the official tournament.
//
// Above everything else on the lobby for two days and then gone, which is the
// only shape a banner about a fixed date can honestly take: one that outlives
// its event makes a live site look abandoned, and one that has to be taken down
// by hand is one that will be up in October. `officialTournamentPromoVisible`
// owns that window, and the sidebar button reads the same function so the two
// appear and disappear together.
//
// It renders nothing at all in the pre-rendered HTML. Whether this should be on
// screen depends on what time it is, and a build-time answer to that is a
// stale answer baked into a static file — see `useNow`.
//
// One press target, not two. A banner with a "read more" and a separate "go to
// the site" is a decision to make about a notice you have read one line of; the
// whole strip opens the page that explains it, and that page is where the two
// outward links are.

export default function OfficialTournamentBanner() {
  const now = useNow();
  if (now === null || !officialTournamentPromoVisible(now)) return null;

  const phase = officialTournamentPhase(now);
  if (phase === 'over') return null;

  const live = phase === 'live';

  return (
    <Link asChild href={links.tournamentInfo()}>
      <Pressable
        accessibilityLabel={`${officialTournament.name} · tournament information`}
        accessibilityRole="link"
        // One resolved style object: `Link asChild` clones this into a real
        // anchor and an array reaches the DOM node as something with numeric
        // keys, which throws on the way in. See the longer note in SidebarNav.
        style={StyleSheet.flatten([styles.banner, live && styles.bannerLive])}
      >
        <View style={styles.markColumn}>
          <View style={[styles.dot, live && styles.dotLive]} />
        </View>
        <View style={styles.copy}>
          <Text style={[styles.eyebrow, live && styles.eyebrowLive]}>
            {live ? 'HAPPENING NOW · NOT ON THIS SITE' : 'OFFICIAL TOURNAMENT · NOT ON THIS SITE'}
          </Text>
          <Text style={styles.title}>{officialTournament.name}</Text>
          <Text style={styles.detail}>
            {live
              ? 'Running now at meaf.us/rps2. Every engine here is offline until 6 PM Eastern.'
              : `${officialTournament.whenLabel} · starts ${untilLabel(
                  now,
                  officialTournament.startsAtUnixMs,
                )}. The bots here go offline ${officialTournament.botsOfflineLabel}.`}
          </Text>
        </View>
        <Text style={styles.chevron}>›</Text>
      </Pressable>
    </Link>
  );
}

const styles = themedSheet(() => ({
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.medium,
    padding: space.medium,
    borderRadius: radius.large,
    borderWidth: 1,
    borderColor: colors.goldBorder,
    backgroundColor: colors.goldSurfaceDeep,
  },
  bannerLive: {
    borderColor: colors.accentBorder,
    backgroundColor: colors.accentSurface,
  },
  markColumn: { paddingHorizontal: space.hair },
  dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.goldDot },
  dotLive: { backgroundColor: colors.accent },
  // `minWidth: 0` so the sentence wraps instead of shoving the chevron off the
  // end of the strip on a phone. See the note in MobileTopBar.
  copy: { flex: 1, minWidth: 0, gap: space.hair },
  eyebrow: { ...type.eyebrow, color: colors.goldMuted },
  eyebrowLive: { color: colors.accentText },
  title: { ...type.rowTitle, color: colors.textStrong, fontSize: 13 },
  detail: { ...type.body, color: colors.textMuted, marginTop: space.hair },
  chevron: { color: colors.textFaint, fontSize: 18 },
}));
