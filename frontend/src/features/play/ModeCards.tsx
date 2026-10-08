import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Text, View, type LayoutChangeEvent } from 'react-native';

import ModePreview from '@/features/game/ModePreview';
import { engineUnavailableMessage } from '@/engine/rpsfish/client';
import { useLobbyGate } from '@/hooks/useQueueCall';
import { links } from '@/navigation/links';
import { useGameStore } from '@/store/gameStore';
import { defaultTimeControlOf, timeControlLabel } from '@/store/setupSelectors';
import { colors, radius, space, themedSheet, type } from '@/theme';
import type { ModeDefinition } from '@/types/game';
import { Badge, GhostButton, PrimaryButton, TextButton } from '@/ui/primitives';

// The lobby's mode cards: one for the main game, and a smaller one per variant.
//
// Three identical cards in a column said there were three equal games here,
// and there are not: there is Intransitive, and there are two variants that
// keep its pieces and change how a game is won. So the main game gets the
// card that is about it — the board at a size worth looking at, the one green
// button on the page — and the variants get a row each with a grey one. Which
// mode is the main one is the catalogue's answer, not this file's: see
// `featuredModeOf`.
//
// Each card reads its own counts out of the store rather than being handed
// them. A player-count broadcast then redraws the card whose number moved, not
// the page around it.

/** How wide the featured card has to be before its board stands beside the copy. */
const FEATURE_TWO_COLUMNS = 560;
const FEATURE_BOARD = 188;
const FEATURE_BOARD_NARROW = 124;
const VARIANT_BOARD = 88;

/** How many people are at a board in this mode right now. */
const usePlayingCount = (mode: ModeDefinition): number =>
  useGameStore((state) => state.modePlayerCounts[mode.id] ?? 0);

/** Whether this browser's own search is in this mode. */
const useSearchingHere = (mode: ModeDefinition): boolean =>
  useGameStore((state) => state.queue.isSearching && state.queue.modeId === mode.id);

/** The rating this mode's queue would use, or null for somebody with no account. */
const useModeRating = (mode: ModeDefinition): number | null =>
  useGameStore((state) => state.account?.modeRatings?.[mode.id]?.elo ?? state.account?.elo ?? null);

interface PlayModeButtonProps {
  mode: ModeDefinition;
  /** The main game's button is the page's one green button; a variant's is grey. */
  emphasis: 'primary' | 'secondary';
  fullWidth?: boolean;
}

/**
 * Join this mode's queue, or leave it.
 *
 * Every *other* mode's button stays live while you are queued, and switching is
 * one press: the store leaves the old queue before joining the new one, because
 * the server allows one search per person. The spinner and the ticking wait are
 * the floating bar's; all that is left here is the way out, in the same place.
 */
function PlayModeButton({ mode, emphasis, fullWidth }: PlayModeButtonProps) {
  const gate = useLobbyGate();
  const connected = useGameStore((state) => state.connectionStatus === 'connected');
  const hasOutgoing = useGameStore((state) => Boolean(state.outgoingChallenge));
  const joinQueue = useGameStore((state) => state.joinQueue);
  const leaveQueue = useGameStore((state) => state.leaveQueue);
  const searchingHere = useSearchingHere(mode);
  const primary = emphasis === 'primary';

  if (searchingHere) {
    return (
      <PrimaryButton
        accessibilityLabel={`Leave the ${mode.name} queue`}
        compact={!primary}
        fullWidth={fullWidth}
        label="IN QUEUE ✕"
        onPress={leaveQueue}
        tone="quiet"
      />
    );
  }
  return (
    <PrimaryButton
      accessibilityLabel={
        gate.needsAccount ? `Play ${mode.name} online, casually` : `Play ${mode.name} online`
      }
      compact={!primary}
      disabled={gate.atBoard || gate.paused || hasOutgoing}
      fullWidth={fullWidth}
      label={
        gate.paused
          ? 'PAUSED'
          : connected
            ? gate.needsAccount
              ? 'PLAY CASUAL ▶'
              : 'PLAY ▶'
            : 'CONNECTING'
      }
      onPress={() => joinQueue(mode.id)}
      tone={primary ? 'accent' : 'quiet'}
    />
  );
}

/** The analysis board for this mode, or why it is closed. */
const useAnalysis = (mode: ModeDefinition) => {
  const router = useRouter();
  const locked = engineUnavailableMessage(mode.id);
  return {
    locked,
    open: () => router.push(links.analysis(mode.id)),
  };
};

export interface ModeCardProps {
  mode: ModeDefinition;
  onHowToPlay: (mode: ModeDefinition) => void;
}

/**
 * The main game, drawn as the thing the page is about.
 *
 * Board beside the copy where there is room for both, and above-left of it on
 * a phone, so the depiction is always the first thing read and the button is
 * never below the fold of its own card. Measured rather than read off the
 * window, because the sidebar and the live rail take their width off the front
 * of it; zero until the first layout reads as the phone shape, which is also
 * what the pre-rendered page has to be.
 */
export function FeaturedModeCard({ mode, onHowToPlay }: ModeCardProps) {
  const [width, setWidth] = useState(0);
  const measure = (event: LayoutChangeEvent) => {
    const measured = Math.round(event.nativeEvent.layout.width);
    setWidth((current) => (current === measured ? current : measured));
  };
  const wide = width >= FEATURE_TWO_COLUMNS;
  const playing = usePlayingCount(mode);
  const rating = useModeRating(mode);
  const searchingHere = useSearchingHere(mode);
  const defaultTimeControl = useGameStore((state) => state.defaultTimeControl);
  const analysis = useAnalysis(mode);

  const kicker = (
    <View style={styles.kickerRow}>
      <Text style={styles.kicker}>THE MAIN GAME</Text>
      <Badge label={`${playing} PLAYING`} tone={playing > 0 ? 'live' : 'neutral'} />
    </View>
  );
  const copy = (
    <View style={styles.featureCopyTop}>
      <Text style={[styles.featureTitle, !wide && styles.featureTitleNarrow]}>{mode.name}</Text>
      <Text style={[styles.featureObjective, !wide && styles.featureObjectiveNarrow]}>
        {mode.objective}
      </Text>
      <View style={styles.facts}>
        {rating !== null ? <Badge label={`RATING ${rating}`} tone="accent" /> : null}
        <Badge label={timeControlLabel(defaultTimeControlOf(defaultTimeControl))} />
      </View>
    </View>
  );
  const analyze = (
    <GhostButton
      accessibilityLabel={`Open the ${mode.name} analysis board`}
      compact={!wide}
      disabled={Boolean(analysis.locked)}
      label={analysis.locked ? 'ANALYSIS LOCKED' : 'ANALYZE'}
      onPress={analysis.open}
    />
  );
  const howTo = (
    <TextButton
      accessibilityLabel={`How to play ${mode.name}`}
      label="How to play"
      onPress={() => onHowToPlay(mode)}
    />
  );

  return (
    <View onLayout={measure} style={[styles.feature, searchingHere && styles.searching]}>
      {wide ? (
        <View style={styles.featureRow}>
          <ModePreview mode={mode} size={FEATURE_BOARD} />
          <View style={styles.featureCopy}>
            <View>
              {kicker}
              {copy}
            </View>
            <View style={styles.actions}>
              <View style={styles.playWide}>
                <PlayModeButton emphasis="primary" fullWidth mode={mode} />
              </View>
              {analyze}
              {howTo}
            </View>
          </View>
        </View>
      ) : (
        <>
          {kicker}
          <View style={styles.featureTop}>
            <ModePreview mode={mode} size={FEATURE_BOARD_NARROW} />
            <View style={styles.featureCopy}>{copy}</View>
          </View>
          <PlayModeButton emphasis="primary" fullWidth mode={mode} />
          <View style={styles.actions}>
            {analyze}
            {howTo}
          </View>
        </>
      )}
      {analysis.locked ? <Text style={styles.locked}>{analysis.locked}</Text> : null}
    </View>
  );
}

/**
 * A variant: the same pieces, won another way.
 *
 * Its board is small and its button is grey, because the choice it offers is a
 * side road rather than the way in. The analysis board and the rules are words
 * rather than buttons for the same reason: two grey buttons and a link on a
 * card this size would outweigh the name.
 */
export function VariantModeCard({ mode, onHowToPlay }: ModeCardProps) {
  const playing = usePlayingCount(mode);
  const searchingHere = useSearchingHere(mode);
  const analysis = useAnalysis(mode);

  return (
    <View style={[styles.variant, searchingHere && styles.searching]}>
      <ModePreview mode={mode} size={VARIANT_BOARD} />
      <View style={styles.variantCopy}>
        <View style={styles.variantHead}>
          <Text style={styles.variantTitle}>{mode.name}</Text>
          <Badge label={`${playing} PLAYING`} tone={playing > 0 ? 'live' : 'neutral'} />
        </View>
        {/*
          Three lines rather than two: at a phone's width the longest objective
          needs all three, and on the web a clamp of two or more does not wrap
          what is left over, it cuts it off behind an ellipsis.
        */}
        <Text numberOfLines={3} style={styles.variantObjective}>
          {mode.objective}
        </Text>
        <View style={styles.actions}>
          <PlayModeButton emphasis="secondary" mode={mode} />
          <TextButton
            accessibilityLabel={`Open the ${mode.name} analysis board`}
            disabled={Boolean(analysis.locked)}
            label={analysis.locked ? 'Analysis locked' : 'Analyze'}
            onPress={analysis.open}
          />
          <TextButton
            accessibilityLabel={`How to play ${mode.name}`}
            label="How to play"
            onPress={() => onHowToPlay(mode)}
          />
        </View>
      </View>
    </View>
  );
}

const styles = themedSheet(() => ({
  // The same chrome as a `Panel`, so the main game sits on the page exactly as
  // every other card does and only its contents say it is the main one.
  feature: {
    gap: space.medium,
    padding: space.large,
    borderRadius: radius.large,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  // Which mode you are queued in. Neutral, like every other state.
  searching: { borderColor: colors.borderLight },
  featureRow: { flexDirection: 'row', alignItems: 'stretch', gap: space.xlarge },
  // The copy spreads over the height of the board rather than floating in the
  // middle of it: what the game is at the top, the way in at the foot.
  featureCopy: { flex: 1, minWidth: 0, justifyContent: 'space-between', gap: space.medium },
  featureTop: { flexDirection: 'row', alignItems: 'flex-start', gap: space.large },
  featureCopyTop: { minWidth: 0 },
  kickerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space.small,
  },
  kicker: { ...type.eyebrow, color: colors.textMuted },
  featureTitle: {
    ...type.hero,
    fontSize: 32,
    lineHeight: 38,
    letterSpacing: -0.6,
    color: colors.textStrong,
    marginTop: space.snug,
  },
  featureTitleNarrow: { fontSize: 24, lineHeight: 30, letterSpacing: -0.4, marginTop: 0 },
  featureObjective: { fontSize: 15, lineHeight: 22, color: colors.textSoft, marginTop: space.snug },
  featureObjectiveNarrow: { ...type.bodyStrong, marginTop: space.tight },
  facts: { flexDirection: 'row', flexWrap: 'wrap', gap: space.snug, marginTop: space.medium },
  actions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    columnGap: space.medium,
    rowGap: space.small,
  },
  // Wide enough to read as the page's main action beside a grey button, which
  // at the label's own width it did not.
  playWide: { minWidth: 180 },
  locked: { ...type.meta, color: colors.textMuted },

  // Shrinkable, because a basis is a floor only when there is room for it: on
  // the narrowest phones the column is under 320 and a card that could not give
  // way ran off the edge of it.
  variant: {
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: 320,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: space.large,
    padding: space.medium,
    borderRadius: radius.large,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  variantCopy: { flex: 1, minWidth: 0, gap: space.tight },
  // Wraps rather than clipping the name: on the narrowest phones the count
  // moves under the name instead of cutting it to "Infiltrati…".
  variantHead: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'space-between',
    columnGap: space.small,
    rowGap: space.tight,
  },
  variantTitle: { ...type.cardTitle, fontSize: 17, color: colors.textStrong, flexShrink: 1 },
  variantObjective: { ...type.bodyStrong, color: colors.textMuted, marginBottom: space.tight },
}));
