import { Slot } from 'expo-router';
import { useEffect } from 'react';
import { StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import BottomTabBar from './BottomTabBar';
import MobileTopBar from './MobileTopBar';
import SubNav from './SubNav';
import SidebarNav from './SidebarNav';
import { useBottomInset } from './bottomInset';
import ServerBanner from './ServerBanner';
import LiveRail from '@/features/live/LiveRail';
import { useWideScreen } from '@/hooks/useBoardLayout';
import { colors } from '@/theme';
import { Banner } from '@/ui/primitives';
import { useGameStore } from '@/store/gameStore';

// The frame every lobby section sits inside.
//
// `Slot` rather than a Tabs navigator, deliberately. Each section is its own
// address so it can be bookmarked and pre-rendered, and each is a fresh mount
// rather than a preserved tab — which for a lobby is the behaviour you want,
// since the whole point of the page is what is true now.
//
// One thing to know before changing the responsive split: `useWideScreen` is
// false on the very first client render, always, because the pages here are
// pre-rendered in Node where there is no viewport and the first render in the
// browser has to match. So the phone layout is what paints first and the desktop
// layout arrives one render later. Reading the width any other way reintroduces
// the hydration mismatch that throws the whole pre-rendered page away.

export default function ShellLayout() {
  const isWide = useWideScreen();
  const setBottomInset = useBottomInset((state) => state.setBottomInset);
  const error = useGameStore((state) => state.error);
  const clearError = useGameStore((state) => state.clearError);

  // Measured rather than guessed, because the tournament call-out floats over
  // every page and has to clear whatever is actually down there — a tab bar
  // plus however much of the phone's chin the safe area claims.
  const measureChrome = (event: LayoutChangeEvent) =>
    setBottomInset(event.nativeEvent.layout.height);

  // The measured bottom chrome disappears with the phone layout. Clear
  // its old measurement after a resize so floating callouts do not keep
  // reserving space for a bar that is no longer there.
  useEffect(() => {
    if (isWide) setBottomInset(0);
  }, [isWide, setBottomInset]);

  // Two strips, and they can both be up: an error is about something this
  // browser just tried to do, and the server banner is about the server. The
  // server's goes first, because it is very often the reason for the error
  // underneath it — a play button that refused because a deploy is in progress
  // reads as a mystery until the line above it explains itself.
  const banner = (
    <>
      {/*
        Bare rather than wrapped: it renders nothing at all most of the time, and
        a padded wrapper around nothing is a blank strip at the top of every page
        for a feature that fires once a week. It carries its own margins.
      */}
      <ServerBanner />
      {error ? (
        <View style={styles.banner}>
          <Banner message={error} onDismiss={clearError} tone="error" />
        </View>
      ) : null}
    </>
  );

  // One tree, not two.
  //
  // The chrome swaps around the page; the page itself keeps its place in the
  // tree, because `Slot` is a navigator and a replaced navigator can come up
  // on a different route than the one it was showing. Two returns, each with
  // its own `<Slot />`, meant a fresh mount of this layout built one navigator
  // and then, one render later, another — see the note above about the phone
  // layout always painting first — and the second came up on the group's
  // index. Nothing noticed while the only way in was the lobby, which *is* the
  // index; a link from the board to any other section landed on the lobby.
  return (
    <SafeAreaView
      edges={isWide ? ['top', 'right', 'bottom', 'left'] : ['right', 'left']}
      style={styles.screen}
    >
      <View style={isWide ? styles.columns : styles.stack}>
        {isWide ? (
          <SidebarNav />
        ) : (
          /*
            The top edge belongs to the header, the same way the bottom one
            belongs to the tab bar. Claimed by the frame instead, the notch band
            is painted in the page's background colour and reads as a stripe
            above a header that is a different colour; claimed here, the header
            simply starts at the top of the screen. Note the frame no longer
            asks for `top` on a phone — two nested SafeAreaViews both claiming an
            edge would inset it twice.
          */
          <SafeAreaView edges={['top']} style={styles.barHolder}>
            <MobileTopBar />
            {/*
              The second row of the phone's navigation: the pages inside the
              group the bar below has open. Part of the header rather than of
              the page, because it belongs to the group and not to whichever of
              its pages is showing — a strip that scrolled away with the page
              would be a different control on every screen. It renders nothing
              for a group holding one page.
            */}
            <SubNav />
          </SafeAreaView>
        )}
        <View style={styles.mainColumn}>
          <View style={styles.main}>
            {banner}
            <Slot />
          </View>
        </View>
        {isWide ? (
          <LiveRail />
        ) : (
          /*
            The tab bar and nothing else. A one-line summary of the live rail
            used to sit above it, opening the whole rail in a sheet — see
            `LiveNowPanel` for where that went and why.
          */
          <SafeAreaView edges={['bottom']} onLayout={measureChrome} style={styles.tabHolder}>
            <BottomTabBar />
          </SafeAreaView>
        )}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  columns: { flex: 1, flexDirection: 'row', alignItems: 'stretch' },
  stack: { flex: 1, flexDirection: 'column' },
  mainColumn: { flex: 1, minWidth: 0 },
  main: { flex: 1, minWidth: 0 },
  banner: { paddingHorizontal: 16, paddingTop: 12 },
  // Both the header's colour, so the safe area above and below the page reads as
  // part of the chrome rather than as a band of page behind it.
  barHolder: { backgroundColor: colors.surfaceSunken },
  tabHolder: { backgroundColor: colors.surfaceSunken },
});
