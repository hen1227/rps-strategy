import { useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';

import LiveRail, { useLiveSnapshot } from './LiveRail';
import { liveHeadline } from './liveSelectors';
import { colors, overlay, radius, space, type } from '@/theme';

// The rail, on a phone.
//
// There is no room beside the content for a panel, and putting the rail at the
// top of one section would hide it from the other six. One line above the tab
// bar is what fits: it is always there, it is always current, and it opens the
// whole rail when somebody wants the detail behind the numbers.

export default function LiveSummaryBar() {
  const snapshot = useLiveSnapshot();
  const [open, setOpen] = useState(false);
  const headline = liveHeadline(snapshot);

  return (
    <>
      <Pressable
        accessibilityHint="Opens the list of live games and open challenges"
        accessibilityLabel={`Happening now: ${headline}`}
        accessibilityRole="button"
        onPress={() => setOpen(true)}
        style={({ pressed }) => [styles.bar, pressed && styles.pressed]}
      >
        <View style={styles.dot} />
        <Text numberOfLines={1} style={styles.headline}>
          {headline}
        </Text>
        <Text style={styles.chevron}>▲</Text>
      </Pressable>

      <Modal
        animationType="slide"
        onRequestClose={() => setOpen(false)}
        transparent
        visible={open}
      >
        <View style={styles.sheetRoot}>
          <Pressable
            accessibilityLabel="Close what is happening now"
            accessibilityRole="button"
            onPress={() => setOpen(false)}
            style={styles.backdrop}
          />
          <View style={styles.sheet}>
            <Pressable
              accessibilityLabel="Close what is happening now"
              accessibilityRole="button"
              onPress={() => setOpen(false)}
              style={styles.grabber}
            >
              <View style={styles.grabberBar} />
            </Pressable>
            <LiveRail embedded />
          </View>
        </View>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.small,
    minHeight: 34,
    paddingHorizontal: space.large,
    borderTopWidth: 1,
    borderTopColor: colors.liveBorder,
    backgroundColor: colors.liveSurface,
  },
  dot: { width: 6, height: 6, borderRadius: 3, backgroundColor: colors.live },
  headline: { ...type.label, flex: 1, color: colors.liveSoft, letterSpacing: 0.4 },
  chevron: { color: colors.liveSoft, fontSize: 8 },

  sheetRoot: { flex: 1, justifyContent: 'flex-end' },
  backdrop: { ...StyleSheet.absoluteFill, backgroundColor: overlay },
  sheet: {
    maxHeight: '82%',
    borderTopLeftRadius: radius.xlarge,
    borderTopRightRadius: radius.xlarge,
    borderTopWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    overflow: 'hidden',
  },
  grabber: { alignItems: 'center', paddingVertical: space.small },
  grabberBar: {
    width: 42,
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.borderLight,
  },
  pressed: { opacity: 0.7 },
});
