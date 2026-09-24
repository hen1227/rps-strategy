import { Link } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import {
  officialTournament,
  officialTournamentPhase,
  officialTournamentPromoVisible,
} from '@/features/tournaments/officialTournament';
import { useNow } from '@/hooks/useNow';
import { links } from '@/navigation/links';
import { colors, radius, space, themedSheet, type } from '@/theme';

// The button in the navigation that leads to the official tournament.
//
// In the sidebar's foot on a desktop and in the More menu's foot on a phone, so
// it is one component rather than two that have to agree about when it appears
// and what it says. Both feet are where the things that are *about* this site
// rather than part of it already live — the credits, the play agreement — and a
// notice about somebody else's event belongs with those.
//
// Two days and then gone. It decides that itself, from
// `officialTournamentPromoVisible`, which the front-page banner reads too: a
// promotion that has to be taken down by hand is one that is still up a month
// later, and the sidebar is the worst place on the site for that to happen.
//
// Nothing at all in the pre-rendered HTML, for the reason `useNow` gives: what
// time it is cannot be answered at build time without baking a stale answer
// into a static file. So the sidebar paints without this and it appears a
// render later, which is the same thing the desktop layout itself does.

export interface TournamentPromoLinkProps {
  /** Called when it is pressed, so the phone's menu can close behind it. */
  onPress?: () => void;
}

export default function TournamentPromoLink({ onPress }: TournamentPromoLinkProps) {
  const now = useNow();
  if (now === null || !officialTournamentPromoVisible(now)) return null;

  const phase = officialTournamentPhase(now);
  if (phase === 'over') return null;
  const live = phase === 'live';

  return (
    // The close handler goes on the `Link` rather than on the `Pressable`:
    // `asChild` replaces the child's own press handler with its own and calls
    // this one on the way through. See the note in MoreMenu.
    <Link asChild href={links.tournamentInfo()} onPress={onPress} replace>
      <Pressable
        accessibilityLabel={`${officialTournament.name} · information`}
        accessibilityRole="link"
        // One resolved style object: see the note in SidebarNav.
        style={StyleSheet.flatten([styles.promo, live && styles.promoLive])}
      >
        <View style={[styles.dot, live && styles.dotLive]} />
        <View style={styles.copy}>
          <Text style={[styles.label, live && styles.labelLive]}>
            {live ? 'TOURNAMENT LIVE NOW' : 'OFFICIAL TOURNAMENT'}
          </Text>
          <Text style={styles.detail}>
            {live ? 'Playing at meaf.us/rps2' : 'Saturday · 12 PM Eastern'}
          </Text>
        </View>
      </Pressable>
    </Link>
  );
}

const styles = themedSheet(() => ({
  promo: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.small,
    minHeight: 40,
    paddingHorizontal: space.small,
    paddingVertical: space.snug,
    borderRadius: radius.medium,
    borderWidth: 1,
    borderColor: colors.goldBorder,
    backgroundColor: colors.goldSurfaceDeep,
  },
  promoLive: { borderColor: colors.accentBorder, backgroundColor: colors.accentSurface },
  dot: { width: 7, height: 7, borderRadius: 4, backgroundColor: colors.goldDot },
  dotLive: { backgroundColor: colors.accent },
  // `minWidth: 0` so the second line ellipsises inside a 232px sidebar rather
  // than pushing the card wider than the column. See the note in MobileTopBar.
  copy: { flex: 1, minWidth: 0 },
  label: { ...type.label, color: colors.goldBright, letterSpacing: 0.6 },
  labelLive: { color: colors.accentTextStrong },
  detail: { ...type.meta, color: colors.textMuted, marginTop: space.hair },
}));
