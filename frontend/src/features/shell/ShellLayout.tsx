import { Slot } from 'expo-router';
import { StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import BottomTabBar from './BottomTabBar';
import MobileTopBar from './MobileTopBar';
import SidebarNav from './SidebarNav';
import { useBottomInset } from './bottomInset';
import LiveRail from '@/features/live/LiveRail';
import LiveSummaryBar from '@/features/live/LiveSummaryBar';
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
  // every page and has to clear whatever is actually down there.
  const measureChrome = (event: LayoutChangeEvent) =>
    setBottomInset(event.nativeEvent.layout.height);

  const banner = error ? (
    <View style={styles.banner}>
      <Banner message={error} onDismiss={clearError} tone="error" />
    </View>
  ) : null;

  if (isWide) {
    return (
      <SafeAreaView edges={['top', 'right', 'bottom', 'left']} style={styles.screen}>
        <View style={styles.columns}>
          <SidebarNav />
          <View style={styles.main}>
            {banner}
            <Slot />
          </View>
          <LiveRail />
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView edges={['top', 'right', 'left']} style={styles.screen}>
      <MobileTopBar />
      <View style={styles.main}>
        {banner}
        <Slot />
      </View>
      {/*
        One measured stack so the two pieces of bottom chrome cannot disagree
        about how tall they are between them.
      */}
      <View onLayout={measureChrome}>
        <LiveSummaryBar />
        <SafeAreaView edges={['bottom']} style={styles.tabHolder}>
          <BottomTabBar />
        </SafeAreaView>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  columns: { flex: 1, flexDirection: 'row', alignItems: 'stretch' },
  main: { flex: 1, minWidth: 0 },
  banner: { paddingHorizontal: 16, paddingTop: 12 },
  tabHolder: { backgroundColor: colors.surfaceSunken },
});
