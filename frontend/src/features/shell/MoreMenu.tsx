import { Link, usePathname } from 'expo-router';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';

import type { Section } from './sections';
import TournamentPromoLink from './TournamentPromoLink';
import { links } from '@/navigation/links';
import { colors, overlayQuiet, radius, space, type } from '@/theme';

// The sections that do not fit across a phone, listed where they were asked for.
//
// This used to be a page. More was a tab like any other, pressing it navigated
// to a list of links, and reaching the leaderboard cost two taps and whatever
// you were looking at. A menu above the bar is the same list without the trip:
// it opens over the page, it closes when it is used or pressed away, and
// nothing you were reading goes anywhere.
//
// It also inherits the sidebar's foot. The video and the play agreement sit at
// the bottom of the desktop navigation, and that page was the only place a
// phone could reach either of them.

/** Where the tab that opened this menu is, so the menu can point back at it. */
export interface MoreAnchor {
  /** The centre of the More tab, in window coordinates. */
  caretX: number;
  /** From the bottom of the window to the top of the tab bar. */
  bottom: number;
}

export interface MoreMenuProps {
  /** Null until the bar has been laid out; the menu then squares itself up. */
  anchor: MoreAnchor | null;
  onClose: () => void;
  /** The sections without a tab of their own, in navigation order. */
  sections: Section[];
  visible: boolean;
}

/** The caret is a square standing on one corner, so it shows two of its sides. */
const CARET = 12;

export default function MoreMenu({ anchor, onClose, sections, visible }: MoreMenuProps) {
  const pathname = usePathname();

  return (
    // `Modal` for the two things a menu needs and a plain overlay would have to
    // grow: it floats clear of the bar's own stacking, and it closes on Escape.
    <Modal animationType="fade" onRequestClose={onClose} transparent visible={visible}>
      <Pressable
        accessibilityLabel="Close the menu"
        accessibilityRole="button"
        onPress={onClose}
        style={styles.backdrop}
      />
      {/*
        The dim stops at the top of the tab bar, so the bar this menu hangs off
        stays lit and the two read as one thing. It is a separate, unpressable
        layer rather than the backdrop's own colour because the backdrop has to
        cover the bar as well: the menu is over it, and a press down there that
        landed on nothing would be a dead patch of screen.
      */}
      <View pointerEvents="none" style={[styles.dim, { bottom: anchor?.bottom ?? 0 }]} />
      {/*
        `box-none` so the strip beside the card is still the backdrop: a menu
        that swallows presses across the whole width of the screen is a menu
        that cannot be dismissed by pressing next to it.
      */}
      <View pointerEvents="box-none" style={[styles.layer, { bottom: anchor?.bottom ?? 0 }]}>
        <View style={styles.menu}>
          {sections.map((section, index) => {
            const current = pathname.startsWith(section.path);
            return (
              // The close goes on the `Link` rather than on the `Pressable`:
              // `asChild` replaces the child's own press handler with its own,
              // and calls the one given here on the way through.
              <Link asChild href={section.href} key={section.id} onPress={onClose} replace>
                <Pressable
                  accessibilityLabel={section.label}
                  accessibilityRole="link"
                  accessibilityState={{ selected: current }}
                  // One resolved style object: see the note in SidebarNav.
                  style={StyleSheet.flatten([
                    styles.item,
                    index > 0 && styles.divided,
                    current && styles.itemCurrent,
                  ])}
                >
                  <View style={[styles.marker, current && styles.markerCurrent]} />
                  <Text style={[styles.itemLabel, current && styles.itemLabelCurrent]}>
                    {section.label}
                  </Text>
                </Pressable>
              </Link>
            );
          })}

          <View style={styles.foot}>
            {/* Only in the days around the event, and it decides that itself. */}
            <TournamentPromoLink onPress={onClose} />

            {/*
              Where this game came from: two videos, the official site, and the
              Discord. A route rather than the single outward link this used to
              be — see the note in SidebarNav.
            */}
            <Link asChild href={links.credits()} onPress={onClose} replace>
              <Pressable
                accessibilityLabel="Where this game came from"
                accessibilityRole="link"
                // One resolved style object: see the note in SidebarNav.
                style={styles.video}
              >
                <Text style={styles.videoMark}>▶</Text>
                <Text style={styles.videoText}>The videos behind this game</Text>
              </Pressable>
            </Link>

            <Link href={links.policy()} onPress={onClose} replace style={styles.policy}>
              Privacy & play agreement
            </Link>
          </View>
        </View>
        {anchor ? <View style={[styles.caret, { left: anchor.caretX - CARET / 2 }]} /> : null}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { ...StyleSheet.absoluteFill },
  dim: { position: 'absolute', top: 0, left: 0, right: 0, backgroundColor: overlayQuiet },
  // No padding on the layer: an absolutely positioned child measures from the
  // padding box, and the caret's `left` is a window coordinate. The card keeps
  // itself off the edge with a margin instead.
  layer: { position: 'absolute', left: 0, right: 0, alignItems: 'flex-end' },
  menu: {
    minWidth: 208,
    maxWidth: 300,
    marginHorizontal: space.medium,
    marginBottom: space.small,
    paddingVertical: space.tight,
    borderRadius: radius.large,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surfaceRaised,
    // So a current row's tint is cut by the card's corners rather than
    // squaring them off.
    overflow: 'hidden',
    boxShadow: [{ offsetX: 0, offsetY: 8, blurRadius: 18, color: 'rgba(23, 22, 19, 0.46)' }],
  },
  // Drawn after the card so its two sides sit over the card's border and the
  // two shapes read as one.
  caret: {
    position: 'absolute',
    bottom: space.hair,
    width: CARET,
    height: CARET,
    transform: [{ rotate: '45deg' }],
    borderRightWidth: 1,
    borderBottomWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surfaceRaised,
  },

  item: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.small,
    minHeight: 42,
    paddingHorizontal: space.medium,
  },
  divided: { borderTopWidth: 1, borderTopColor: colors.borderSoft },
  itemCurrent: { backgroundColor: colors.accentSurfaceQuiet },
  // See the note in SidebarNav: an anchor around a Pressable does not carry the
  // Pressable's alignment, so the marker states its own.
  marker: {
    width: 3,
    height: 16,
    alignSelf: 'center',
    borderRadius: 2,
    backgroundColor: 'transparent',
  },
  markerCurrent: { backgroundColor: colors.accent },
  itemLabel: {
    ...type.bodyStrong,
    flex: 1,
    alignSelf: 'center',
    color: colors.textMuted,
    fontWeight: '800',
  },
  itemLabelCurrent: { color: colors.textStrong },

  foot: {
    gap: space.snug,
    marginTop: space.tight,
    paddingTop: space.small,
    paddingHorizontal: space.small,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  video: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.snug,
    minHeight: 34,
    paddingHorizontal: space.small,
    borderRadius: radius.medium,
    borderWidth: 1,
    borderColor: colors.dangerBorder,
    backgroundColor: colors.dangerSurfaceQuiet,
  },
  videoMark: { color: colors.dangerSoft, fontSize: 10 },
  videoText: { ...type.label, color: colors.textSubtle, letterSpacing: 0.4 },
  policy: { ...type.meta, color: colors.textFaint, padding: space.small },
});
