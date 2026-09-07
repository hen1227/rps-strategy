import { Link } from 'expo-router';
import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { Href } from 'expo-router';

import { colors, radius, space, type } from '@/theme';

// The one navigation control, in the one place people reach for it.
//
// Every page that is underneath another page draws this, at the top left,
// and nothing else on this site draws a back button anywhere. That is the whole
// idea: the target is the same shape, in the same corner, on the board, on a
// review, on a bot battle, on the protocol reference and on a player's page, so
// finding the way out is a habit rather than a search. The screens used to
// disagree about all three — a bare `‹` chip on three of them, a text trail on
// four, a "Return to lobby" button on the right of the status card on the
// board, and nothing at all on several pages.
//
// It says where it goes. A bare chevron is only readable to somebody who
// already knows what is behind it, and the label is what makes the button
// answer "where am I" as well as "how do I leave".
//
// `href` is the ordinary case and it is a real link: on the web that means
// middle-click, copy-link, and an address a crawler can follow. `onPress` is
// the exception, for the board — leaving a game has to close its chat room and
// drop the spectator's seat before it can navigate.

export interface BackLinkProps {
  /** The page this returns to, by name. */
  label: string;
  /** Where it goes. Omitted only when `onPress` handles the leaving itself. */
  href?: Href;
  /** For a screen that has state to drop before it can navigate. */
  onPress?: () => void;
  /**
   * Present but not pressable, for a page there is genuinely no leaving yet —
   * a rated game in progress, which the app would bounce straight back to.
   * Drawn rather than hidden, because a control that comes and goes is what
   * made people hunt for it in the first place.
   */
  disabled?: boolean;
  /** Why it is disabled. Read out, and shown as a hint beside nothing else. */
  hint?: string;
}

export default function BackLink({ label, href, onPress, disabled, hint }: BackLinkProps) {
  const body = (
    <>
      <Text style={[styles.chevron, disabled && styles.dim]}>‹</Text>
      <Text numberOfLines={1} style={[styles.label, disabled && styles.dim]}>
        {label}
      </Text>
    </>
  );

  const frame = (child: ReactNode) => <View style={styles.frame}>{child}</View>;

  if (disabled) {
    return frame(
      <View
        accessibilityHint={hint}
        accessibilityLabel={`Back to ${label}`}
        accessibilityRole="button"
        accessibilityState={{ disabled: true }}
        aria-disabled
        style={[styles.button, styles.disabled]}
      >
        {body}
      </View>,
    );
  }

  if (href) {
    return frame(
      // One resolved style object, and no `({ pressed }) => [...]`: `Link
      // asChild` clones this into a real anchor and drops anything else. See
      // the longer note in SidebarNav.
      <Link asChild href={href}>
        <Pressable
          accessibilityHint={hint}
          accessibilityLabel={`Back to ${label}`}
          accessibilityRole="link"
          style={StyleSheet.flatten(styles.button)}
        >
          {body}
        </Pressable>
      </Link>,
    );
  }

  return frame(
    <Pressable
      accessibilityHint={hint}
      accessibilityLabel={`Back to ${label}`}
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [styles.button, pressed && styles.pressed]}
    >
      {body}
    </Pressable>,
  );
}

const styles = StyleSheet.create({
  // A row around the pill, so one control fits both places it is drawn without
  // a prop deciding which. In a column — a `ScreenShell` page, a `PageHeading`
  // — this takes the full width and the pill inside it takes only its content,
  // which is what `alignSelf: 'flex-start'` used to do. In a header row — the
  // board, a review, a battle — the pill would have been pinned to the *top* of
  // the row by that same `alignSelf`, because in a row the cross axis is the
  // vertical one; this frame has no cross-axis opinion, so the row's own
  // `alignItems: 'center'` centres it.
  //
  // It never shrinks. "‹ Lo…" is worse than no label at all, and this is the
  // one control on the page that has to stay legible — so the crowded headers
  // wrap around it instead, which is what the review screen already did with
  // its depth chip.
  frame: { flexDirection: 'row', flexShrink: 0 },
  button: {
    flexDirection: 'row',
    alignItems: 'center',
    flexShrink: 0,
    gap: space.snug,
    // Tall enough to be a comfortable target on a phone, and the same height as
    // the chips that sit beside it in a board's top bar.
    minHeight: 38,
    paddingLeft: space.small,
    paddingRight: space.medium,
    borderRadius: radius.large,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  label: { ...type.rowTitle, flexShrink: 0, color: colors.text },
  chevron: { flexShrink: 0, color: colors.textSubtle, fontSize: 22, lineHeight: 24, marginTop: -3 },
  dim: { color: colors.textFaint },
  disabled: { opacity: 0.55 },
  pressed: { opacity: 0.68 },
});
