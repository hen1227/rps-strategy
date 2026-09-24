import type { ReactNode } from 'react';
import {
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
} from 'react-native';

import { colors, space, themedSheet, type } from '@/theme';

// One row of a table.
//
// The lobby's live-game rows and the connected-engine rows were already the same
// shape on purpose, and the leaderboard, the open-challenge board, and the
// tournament history all want it too. Five copies of "54px tall, hairline rule
// on top, art, two lines of copy, badges, an action" is five chances for one of
// them to drift. (The bots page's own engine list has since become a grid of
// cards — see `EngineBotCard` — because a dozen near-identical rows read as a
// log rather than as a roster. The rail's engine rows are still these.)

/**
 * How a row's first line is drawn.
 *
 * Exported because a `title` handed in as a node styles itself — see below —
 * and a row whose first line has a link in it has to be a node. Taking the
 * style from here rather than writing the same two tokens again is what keeps
 * such a row looking like the plain ones above and below it.
 *
 * A function rather than a constant, because a constant would be read once at
 * import and then keep the colour of whichever theme happened to be showing
 * then — in every file that imported it, which is the part that makes this one
 * worse than an ordinary stale capture.
 */
export const rowTitleText = (): TextStyle => ({ ...type.rowTitle, color: colors.text });

export interface ListRowProps {
  /** Art at the leading edge: a bot portrait, a rank number, an avatar. */
  leading?: ReactNode;
  /** The first line. A string is styled for you; a node is left alone. */
  title: ReactNode;
  /** The dim second line. */
  meta?: ReactNode;
  /**
   * How many lines that second line may take. One, for a table row: a list of
   * live games or leaderboard rows is scanned down a column, and a row that is
   * sometimes two lines tall breaks that.
   *
   * A *navigation* row's second line is a sentence rather than a field, and a
   * sentence does not fit in the 232 points a phone gives it — so `LinkRow`
   * asks for two and keeps its copy, instead of losing everything past the
   * ellipsis. It costs no height either way: this row's `minHeight` is 54 and a
   * title over two lines of meta is 51.
   */
  metaLines?: number;
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
  metaLines = 1,
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
          <Text numberOfLines={metaLines} style={styles.meta}>
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

const styles = themedSheet(() => ({
  row: {
    minHeight: 54,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.small,
  },
  divided: { borderTopWidth: 1, borderTopColor: colors.borderSoft },
  copy: { flex: 1 },
  title: rowTitleText(),
  meta: { ...type.meta, color: colors.textFaint, marginTop: space.hair },
}));
