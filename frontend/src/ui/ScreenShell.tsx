import type { ReactNode } from 'react';
import { ScrollView, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { colors, contentWidth, space } from '@/theme';

// The page frame, in one place.
//
// Eleven screens each opened with their own SafeAreaView, their own ScrollView,
// their own padding, and their own maxWidth — 640, 760, 900, 1100, 1180, 1200,
// 1240. Those numbers were not decisions about those pages; they were whatever
// each screen was written with. What a page genuinely chooses is how much room
// its content wants, which is the `width` prop, and whether it scrolls at all.
//
// Deliberately no header. Inside the app shell the navigation is the sidebar or
// the tab bar, and a per-page back button next to them would be two answers to
// the same question.

export interface ScreenShellProps {
  children?: ReactNode;
  /** How wide the content may grow. Defaults to a page of panels. */
  width?: number;
  /**
   * False for a page that manages its own scrolling — a board, or anything with
   * a list that has to stay pinned.
   */
  scroll?: boolean;
  /** Extra room at the bottom, for chrome floating over the page. */
  bottomInset?: number;
  contentStyle?: StyleProp<ViewStyle>;
}

export default function ScreenShell({
  children,
  width = contentWidth.standard,
  scroll = true,
  bottomInset = 0,
  contentStyle,
}: ScreenShellProps) {
  const content = (
    <View style={[styles.content, !scroll && styles.contentFlush, { maxWidth: width }, contentStyle]}>
      {children}
    </View>
  );
  if (!scroll) {
    return <View style={[styles.page, { paddingBottom: bottomInset }]}>{content}</View>;
  }
  return (
    <ScrollView
      contentContainerStyle={[styles.scroll, { paddingBottom: bottomInset }]}
      keyboardShouldPersistTaps="handled"
      showsVerticalScrollIndicator={false}
      style={styles.page}
    >
      {content}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.background },
  scroll: { flexGrow: 1 },
  content: {
    width: '100%',
    alignSelf: 'center',
    gap: space.medium,
    paddingHorizontal: space.large,
    paddingTop: space.large,
    paddingBottom: space.xlarge,
  },
  // The frame for a page that scrolls itself, and it differs from the one above
  // in both directions.
  //
  // No vertical padding, because this View is *outside* that page's ScrollView.
  // Padding out here is not room the content scrolls through, it is a band the
  // content is clipped at — the first row sliced in half against the top bar
  // with a strip of background above it, and the last card sliced against the
  // tab bar. The page carries the same room inside its own
  // `contentContainerStyle`, where it scrolls.
  //
  // And `flex: 1` with `minHeight: 0`, because without a height here there is
  // nothing for the page's ScrollView to scroll *within*: it is `flexGrow: 1`
  // inside an auto-height parent, so it resolves to the height of its own
  // content, reports nothing to scroll, and simply overflows the frame and gets
  // clipped. The same react-native-web trap the two `flexGrow: 0` comments in
  // `OpeningExplorerScreen` are about, one level further out.
  contentFlush: { flex: 1, minHeight: 0, paddingTop: 0, paddingBottom: 0 },
});
