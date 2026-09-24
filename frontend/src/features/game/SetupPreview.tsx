import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { LayoutChangeEvent } from 'react-native';

import ModePreview from './ModePreview';
import { describeSetup } from '@/store/setupSelectors';
import { colors, radius, space, themedSheet, type } from '@/theme';
import { Badge } from '@/ui/primitives';
import type { GameSetup, ModeDefinition, TimeControl } from '@/types/game';

// A game, at a glance: the board it starts from with its terms listed under it.
//
// The board is doing two jobs, which is why it is a board and not a label. It
// shows the position the game actually begins in — the whole point of a custom
// game — and, because each mode tints and marks its own board, it also says
// which mode this is without spending a line of text on the name. The bullets
// under it are the rest of the terms, the departures from a normal game marked
// as such.
//
// Four sizes, because the same object has to survive four amounts of room.
// A rail has none, so `compact` drops to icons and moves the words to the
// accessibility label. A list row has a column, which is `standard`. And a
// screen that is *about* one game — the challenge you are writing, the settings
// you are adjusting — gives it a column of its own, which is `feature`: a card
// that names the mode, carries the change count, and stretches to whatever it
// is standing beside, so the game being described has the same weight on the
// page as the form describing it.
//
// `banner` is that same card turned on its side, for a phone. A dialog whose
// controls are already taller than the screen has no column to spare, but it
// still has to show the game it is editing — so the board shrinks, the terms
// move alongside it, and the whole thing fits above the knobs instead of
// waiting at the bottom of a scroll nobody reaches.

/** How much room the preview has, and so how much of the game it spells out. */
export type SetupPreviewSize = 'compact' | 'standard' | 'feature' | 'banner';

/**
 * The feature card is a column beside a form, so its width is the fixed thing.
 *
 * Exported because a caller putting it beside a form is the one that has to
 * know whether there is room for both — see `PlayOnlineScreen`, where a panel
 * too narrow for the pair stacks them instead. It stretches on request, but it
 * does not shrink: 240 is the smallest this card reads as a card.
 */
export const SETUP_CARD_WIDTH = 240;
const FEATURE_PAD = space.medium;
/** How much of a stretched card's width the board may take before it stops. */
const FEATURE_BOARD_MAX = 320;
/** The board in a banner: small enough to leave the terms a readable column. */
const BANNER_BOARD = 148;
/** …and a share of the card, so the smallest phones give the knobs their room. */
const BANNER_SHARE = 0.4;

const BOARD: Record<SetupPreviewSize, number> = {
  compact: 68,
  standard: 116,
  // Whatever is left inside the card once its padding and border are paid.
  feature: SETUP_CARD_WIDTH - 2 * FEATURE_PAD - 2,
  banner: BANNER_BOARD,
};

/** The board inside a card of this width, kept between legible and excessive. */
const boardForWidth = (width: number) =>
  Math.round(Math.max(96, Math.min(FEATURE_BOARD_MAX, width - 2 * FEATURE_PAD - 2)));

/** The same question for a banner, where the terms have to fit alongside it. */
const bannerBoardForWidth = (width: number) =>
  Math.round(Math.max(96, Math.min(BANNER_BOARD, width * BANNER_SHARE)));

export interface SetupPreviewProps {
  setup: GameSetup;
  /** The mode the setup names, for the tinting, goal ranks, and comparison. */
  mode: ModeDefinition | null | undefined;
  defaultTimeControl?: TimeControl | null;
  size?: SetupPreviewSize;
  /**
   * Let a feature card take the width it is given instead of its own.
   *
   * The fixed width is right for a column beside a form and wrong for anything
   * else: given a phone's full width it kept a 214-point board and left the
   * rest of the card empty beside it. A stretched card measures itself and
   * grows its board to match, which is the only part of it that can use the
   * room.
   */
  stretch?: boolean;
  /**
   * The line under the terms, saying what becomes of this game. Cards only:
   * it is the one thing the setup cannot know about itself, and the smaller
   * sizes appear next to a row that already says it.
   */
  caption?: string;
}

export default function SetupPreview({
  setup,
  mode,
  defaultTimeControl,
  size = 'standard',
  stretch,
  caption,
}: SetupPreviewProps) {
  const bullets = describeSetup(setup, mode, defaultTimeControl);
  const compact = size === 'compact';
  const feature = size === 'feature';
  const banner = size === 'banner';
  // The two sizes that are a card rather than a stack: both name the mode and
  // both have the room to spell their terms out in words.
  const card = feature || banner;
  // Measured rather than assumed, for the two cards whose width is not theirs
  // to pick. `null` until the first layout, which is the fixed width — so a
  // card never renders board-less while it waits to be measured.
  const [cardWidth, setCardWidth] = useState<number | null>(null);
  const measure = (event: LayoutChangeEvent) => {
    const width = Math.round(event.nativeEvent.layout.width);
    setCardWidth((current) => (current === width ? current : width));
  };
  const measured = banner || (feature && stretch);
  const board =
    measured && cardWidth
      ? banner
        ? bannerBoardForWidth(cardWidth)
        : boardForWidth(cardWidth)
      : BOARD[size];
  // The icons carry no meaning on their own, so the compact form still names
  // every term to a screen reader even though it has no room to print them.
  const spoken = bullets.map((bullet) => bullet.label).join(', ');
  // The same count the panel heading used to carry as a badge. It belongs on
  // the thing it is counting, where the bullets it is counting are visible.
  const changes = bullets.filter((bullet) => bullet.custom).length;

  const head = card ? (
    <View style={styles.head}>
      <Text numberOfLines={1} style={styles.headTitle}>
        {mode?.name ?? 'Custom game'}
      </Text>
      <Badge
        label={changes === 0 ? 'STANDARD' : `${changes} CHANGED`}
        tone={changes === 0 ? 'neutral' : 'accent'}
      />
    </View>
  ) : null;

  const terms = (
    <View
      accessibilityElementsHidden={compact}
      style={[styles.bullets, compact && styles.bulletsCompact, card && styles.bulletsCard]}
    >
      {bullets.map((bullet) => (
        <View key={bullet.key} style={[styles.bullet, card && styles.bulletCard]}>
          <Text style={[styles.icon, card && styles.iconCard, bullet.custom && styles.iconCustom]}>
            {bullet.icon}
          </Text>
          {compact ? null : (
            <Text
              numberOfLines={2}
              style={[
                styles.label,
                card && styles.labelCard,
                bullet.custom && styles.labelCustom,
              ]}
            >
              {bullet.label}
            </Text>
          )}
        </View>
      ))}
    </View>
  );

  const footnote = card && caption ? <Text style={styles.caption}>{caption}</Text> : null;

  // The banner's terms sit beside its board rather than under it, so it is the
  // one size whose parts are not a single column. The mode's name stays across
  // the top, where it has the whole card to be long in: sharing the terms'
  // column with the badge left "Total War" as "T..." on a 320-point screen.
  if (banner) {
    return (
      <View onLayout={measure} style={styles.frameBanner}>
        {head}
        <View style={styles.bannerRow}>
          <ModePreview mode={mode} position={setup.startingPosition} size={board} />
          <View style={styles.bannerCopy}>
            {terms}
            {footnote}
          </View>
        </View>
      </View>
    );
  }

  return (
    <View
      accessibilityLabel={compact ? spoken : undefined}
      onLayout={measured ? measure : undefined}
      style={[
        styles.frame,
        compact && styles.frameCompact,
        feature && styles.frameFeature,
        feature && stretch && styles.frameStretch,
      ]}
    >
      {head}
      <ModePreview mode={mode} position={setup.startingPosition} size={board} />
      {terms}
      {footnote}
    </View>
  );
}

const styles = themedSheet(() => ({
  frame: { alignItems: 'stretch', gap: space.snug, width: BOARD.standard + 2 * space.small },
  frameCompact: { width: BOARD.compact + 2 * space.small, gap: space.tight },
  // A card rather than a bare stack, so that stretching it to a neighbour's
  // height reads as a panel holding its space rather than a thumbnail adrift in
  // it. The contents centre in whatever room that turns out to be.
  frameFeature: {
    width: SETUP_CARD_WIDTH,
    alignSelf: 'stretch',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.medium,
    padding: FEATURE_PAD,
    borderRadius: radius.large,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surfaceSunken,
  },
  // Wide as its column, with the board centred in it and the terms across the
  // full width underneath: the shape a phone wants, where the column *is* the
  // screen.
  frameStretch: { width: '100%' },

  // Turned on its side: the board on the left, everything the board cannot say
  // on the right. `minWidth: 0` on the copy is what lets a long term wrap
  // instead of pushing the board off the card.
  frameBanner: {
    alignSelf: 'stretch',
    gap: space.small,
    padding: FEATURE_PAD,
    borderRadius: radius.large,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surfaceSunken,
  },
  bannerRow: { flexDirection: 'row', alignItems: 'center', gap: space.medium },
  bannerCopy: { flex: 1, minWidth: 0, gap: space.snug },

  head: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    alignSelf: 'stretch',
    gap: space.small,
  },
  headTitle: { ...type.cardTitle, color: colors.textStrong, flexShrink: 1 },

  // One bullet per line at full size: these are terms of a game, and a reader
  // scanning for the one that matters should not have to hunt across a wrap.
  bullets: { alignSelf: 'stretch', gap: space.hair, paddingHorizontal: space.hair },
  // No room for that in a rail, so the icons become a single row of marks and
  // the words move to the accessibility label.
  bulletsCompact: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'center',
    gap: space.tight,
  },
  bulletsCard: { gap: space.tight, paddingHorizontal: 0 },

  bullet: { flexDirection: 'row', alignItems: 'center', gap: space.tight },
  bulletCard: { gap: space.small },
  icon: { ...type.label, color: colors.textFaint, width: 10, textAlign: 'center' },
  iconCard: { fontSize: 12, width: 14 },
  iconCustom: { color: colors.accentSoft },
  label: { ...type.meta, flex: 1, fontSize: 9, lineHeight: 12, color: colors.textFaint },
  labelCard: { ...type.body, flex: 1, minWidth: 0, color: colors.textMuted },
  labelCustom: { color: colors.accentText, fontWeight: '700' },

  caption: {
    ...type.meta,
    alignSelf: 'stretch',
    color: colors.textFaint,
    paddingTop: space.small,
    borderTopWidth: 1,
    borderTopColor: colors.borderSoft,
  },
}));
