import type { ReactNode } from 'react';
import { StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';

import { colors, space, type } from '@/theme';

// One row of a table.
//
// The lobby's live-game rows and the connected-engine rows were already the same
// shape on purpose — `EngineBotRow` says so in its own comment — and the
// leaderboard, the open-challenge board, and the tournament history all want it
// too. Five copies of "54px tall, hairline rule on top, art, two lines of copy,
// badges, an action" is five chances for one of them to drift.

export interface ListRowProps {
  /** Art at the leading edge: a bot portrait, a rank number, an avatar. */
  leading?: ReactNode;
  /** The first line. A string is styled for you; a node is left alone. */
  title: ReactNode;
  /** The dim second line. */
  meta?: ReactNode;
  /** A third line for anything that needs its own row, like a series tally. */
  detail?: ReactNode;
  /** Badges and buttons at the trailing edge. */
  trailing?: ReactNode;
  /**
   * Whether to draw the rule above this row. The first row in a list usually
   * sits under a heading that already provides the separation.
   */
  divided?: boolean;
  style?: StyleProp<ViewStyle>;
}

export default function ListRow({
  leading,
  title,
  meta,
  detail,
  trailing,
  divided = true,
  style,
}: ListRowProps) {
  return (
    <View style={[styles.row, divided && styles.divided, style]}>
      {leading}
      <View style={styles.copy}>
        {typeof title === 'string' ? (
          <Text numberOfLines={1} style={styles.title}>
            {title}
          </Text>
        ) : (
          title
        )}
        {typeof meta === 'string' ? (
          <Text numberOfLines={1} style={styles.meta}>
            {meta}
          </Text>
        ) : (
          meta
        )}
        {detail}
      </View>
      {trailing}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    minHeight: 54,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.small,
  },
  divided: { borderTopWidth: 1, borderTopColor: colors.borderSoft },
  copy: { flex: 1 },
  title: { ...type.rowTitle, color: colors.text },
  meta: { ...type.meta, color: colors.textFaint, marginTop: space.hair },
});
