import { useState } from 'react';
import { StyleSheet, Pressable, Text, View } from 'react-native';

import BotIcon from './BotIcon';
import { pitBarView } from './pitSelection';
import type { BotSeriesForm } from './useBotSeriesForm';
import { botIconUrl } from '@/store/api/bots';
import { colors, radius, space, themedSheet, type } from '@/theme';
import { Banner, PrimaryButton } from '@/ui/primitives';
import type { ModeDefinition } from '@/types/game';
import type { BotPresence } from '@/types/protocol';

// The press that starts the run, next to the press that set it up.
//
// The two engines are chosen on the cards at the top of this page, and the form
// that describes the run is a panel below them — which on a phone with a dozen
// engines online is two or three screens down. So choosing two engines used to
// end in a question: there was nothing on screen that would make them fight.
//
// This is that button, pinned to the foot of the page from the moment the first
// engine is entered. It shows the fight rather than announcing itself: the
// portraits facing each other, an empty `?` on the side still to be filled, and
// one line saying what the run would be. The `?` is the point of appearing after
// *one* pick rather than two — the answer to "then what" is "pick another one",
// and it is worth saying at the moment the question is asked. It is not worth
// answering by choosing an opponent on somebody's behalf.
//
// Deliberately the same card as the queue and tournament call-outs: a player
// should not have to learn a second shape for "something down here wants your
// attention". It is not *in* that layer, though — see CalloutLayer, which owns
// one strip with one winner, and `lift` below, which is how this stays clear of
// whichever card is in it.

/** Wide enough for the fight, the line and the button to share a row. */
const ONE_ROW_WIDTH = 420;

/** Half the panel's 64, so the bar reads as a launcher and not a second form. */
const PORTRAIT = 36;

/**
 * One engine, or the space one goes in.
 *
 * Pressing a filled side empties it, which is the behaviour the panel's own
 * slots have and the same label they carry — the two are one control in two
 * places, and a screen reader should not hear them differently. The empty side
 * is not pressable, and is hidden from the reader entirely: there is nothing to
 * do to it, and a lone "?" read aloud is noise. The line beside it is what says
 * where the answer comes from.
 */
function PitBarSide({
  bot,
  mirrored,
  onClear,
  role,
  spread,
}: {
  bot: BotPresence | null;
  /**
   * Draw this side facing the other one: portrait at the outer edge, name
   * running inward. Only while the row has the whole card to itself — sharing
   * a row with the line and the button, the two sides hug the leading edge and
   * a mirrored second one would just be a gap in the middle of a sentence.
   */
  mirrored?: boolean;
  /**
   * Take half the row, so VS lands in the middle of the card rather than
   * wherever this engine's name happens to end. Both sides get it; only the
   * second is mirrored.
   */
  spread?: boolean;
  onClear: () => void;
  role: 'first' | 'second';
}) {
  if (!bot) {
    return (
      <View
        accessible={false}
        style={[styles.empty, spread && styles.sideSpread, mirrored && styles.emptyMirrored]}
      >
        <View style={styles.emptyArt}>
          <Text style={styles.query}>?</Text>
        </View>
      </View>
    );
  }
  return (
    <Pressable
      accessibilityLabel={`Take ${bot.name} out of the ${role} slot`}
      accessibilityRole="button"
      onPress={onClear}
      style={({ pressed }) => [
        styles.side,
        spread && styles.sideSpread,
        mirrored && styles.sideMirrored,
        pressed && styles.pressed,
      ]}
    >
      <BotIcon name={bot.name} size={PORTRAIT} uri={botIconUrl(bot.botId, bot.iconSha256)} />
      {/*
        `minWidth: 0` on the name as well as `numberOfLines`: an engine called
        `mocca-v2-20260907-g1360` is one unbreakable word, and a flex item will
        not shrink below one of those without it — the START button gets pushed
        off the card instead.
      */}
      <Text numberOfLines={1} style={[styles.sideName, mirrored && styles.sideNameMirrored]}>
        {bot.name}
      </Text>
    </Pressable>
  );
}

export interface PitBarProps {
  /** The engine on the first side, which opens game one of every pair. */
  first: BotPresence | null;
  second: BotPresence | null;
  /** How many engines could be entered right now. */
  available: number;
  /** The mode the run is played at, chosen once for the page above. */
  mode: ModeDefinition;
  /** The run being set up, shared with the panel that describes it. */
  form: BotSeriesForm;
  onClear: (side: 'first' | 'second') => void;
  /** Room the floating call-out layer wants, so this sits above its card. */
  lift?: number;
  /** Measured up to the page, so the last panel can clear this bar. */
  onHeight?: (height: number) => void;
}

export default function PitBar({
  first,
  second,
  available,
  mode,
  form,
  onClear,
  lift = 0,
  onHeight,
}: PitBarProps) {
  // Measured on the card rather than read off the window: this page sits in a
  // column between the shell's sidebar and its live rail, and the window is a
  // long way wider than the space the bar actually has. `useWideScreen` is also
  // false on the very first client render, always, so a flag taken from it would
  // arrive a render late.
  const [narrow, setNarrow] = useState(false);
  const view = pitBarView({
    available,
    clock: form.clock,
    first,
    mode,
    pairs: form.pairs,
    second,
  });
  if (!view.visible) return null;

  return (
    <View
      pointerEvents="box-none"
      style={[styles.layer, { paddingBottom: lift + space.medium }]}
    >
      {/*
        One direct child, and it must stay that way: react-native-web compiles
        `box-none` to `pointer-events: none` on this layer plus `auto` on its
        immediate children only, so a wrapper slipped in between would make the
        whole bar untappable on the web.
      */}
      <View
        onLayout={(event) => {
          const { height, width } = event.nativeEvent.layout;
          // Rounded because react-native-web reports fractional heights, and a
          // subpixel wobble would re-render the page on every layout pass. Safe
          // against oscillation: this card is absolutely positioned, so the room
          // the page reserves for it cannot change its own width or height.
          onHeight?.(Math.round(height));
          setNarrow(width < ONE_ROW_WIDTH);
        }}
        style={styles.card}
      >
        {/*
          The outcome of the press, where the press was. The panel two screens
          down carries the same banner for the failures that start there.
        */}
        {form.error ? (
          <View style={styles.banner}>
            <Banner message={form.error} onDismiss={form.dismissError} tone="error" />
          </View>
        ) : null}

        <View style={[styles.body, narrow && styles.bodyStacked]}>
          {/*
            Stacked, this row owns the whole card, so the two sides take an end
            each and face inward — which is what makes two portraits read as a
            fight rather than as the left half of a list with the right half
            missing. That gap is the whole reason for the treatment: with one
            engine entered there is nothing on the right, and an empty right
            side reads as unfinished rather than as waiting.
          */}
          <View style={[styles.fight, narrow && styles.fightSpread]}>
            <PitBarSide
              bot={first}
              onClear={() => onClear('first')}
              role="first"
              spread={narrow}
            />
            <Text style={styles.versus}>VS</Text>
            <PitBarSide
              bot={second}
              mirrored={narrow}
              onClear={() => onClear('second')}
              role="second"
              spread={narrow}
            />
          </View>

          {/*
            What the run would be, or what is still missing. One or the other:
            the settings of a run that cannot start yet are not the sentence
            somebody with one engine entered needs.
          */}
          <Text
            numberOfLines={2}
            style={[styles.line, view.hint ? styles.hint : null, !narrow && styles.lineWide]}
          >
            {view.hint ?? view.settings}
          </Text>

          <PrimaryButton
            accessibilityLabel={view.action}
            disabled={!form.canStart}
            fullWidth={narrow}
            label={view.label}
            loading={form.busy}
            onPress={() => void form.start()}
          />
        </View>
      </View>
    </View>
  );
}

const styles = themedSheet(() => ({
  layer: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    paddingHorizontal: space.medium,
  },
  // The queue call-out's card, on purpose. See the note at the top.
  card: {
    width: '100%',
    maxWidth: 620,
    overflow: 'hidden',
    padding: space.medium,
    borderRadius: radius.large,
    borderWidth: 1,
    borderColor: colors.accentBorder,
    backgroundColor: colors.accentSurfaceQuiet,
    // Keeps the bar readable over the roster it floats on, on web and native.
    shadowColor: colors.surfaceDeep,
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.4,
    shadowRadius: 12,
    elevation: 8,
  },
  banner: { marginBottom: space.small },
  body: { flexDirection: 'row', alignItems: 'center', gap: space.medium },
  bodyStacked: { flexDirection: 'column', alignItems: 'stretch', gap: space.small },
  fight: { flexDirection: 'row', alignItems: 'center', gap: space.snug, minWidth: 0 },
  fightSpread: { justifyContent: 'space-between' },
  side: { flexDirection: 'row', alignItems: 'center', gap: space.tight, minWidth: 0, flexShrink: 1 },
  // An end each, so VS lands in the middle of the card at every width.
  sideSpread: { flexGrow: 1, flexBasis: 0 },
  sideMirrored: { flexDirection: 'row-reverse' },
  sideName: { ...type.rowTitle, color: colors.textStrong, flexShrink: 1, minWidth: 0 },
  sideNameMirrored: { textAlign: 'right' },
  empty: { flexDirection: 'row', alignItems: 'center', minWidth: 0 },
  emptyMirrored: { justifyContent: 'flex-end' },
  emptyArt: {
    width: PORTRAIT,
    height: PORTRAIT,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.small,
    borderWidth: 1,
    borderColor: colors.borderSoft,
    borderStyle: 'dashed',
  },
  query: { fontSize: 18, fontWeight: '900', color: colors.borderLight },
  versus: { ...type.meta, fontWeight: '900', color: colors.textFaint },
  line: { ...type.meta, color: colors.textMuted, minWidth: 0 },
  // `flex` only while the three parts share a row. In a column it would stretch
  // the line's *height* instead, which is the wrong axis and pushes the button
  // off the card.
  lineWide: { flex: 1 },
  hint: { ...type.label, color: colors.accentSoft },
  pressed: { opacity: 0.7 },
}));
