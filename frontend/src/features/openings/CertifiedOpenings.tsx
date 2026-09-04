// The openings the engine will stand behind, and nothing else.
//
// This replaced a "featured openings" strip that showed the best three lines
// followed a fixed twelve plies, whether or not the search behind them had
// ever separated the moves along them. That is why the page used to carry a
// lot of openings nobody should have trusted: a principal line runs to
// whatever length it is asked for.
//
// A certified opening runs while exactly one continuation is strictly best and
// stops where the engine is indifferent. So each card here carries its own
// evidence -- how deep the shallowest search along it was, and why it ends --
// and an empty list is a real answer rather than a reason to fall back.

import { useMemo, useState } from 'react';
import {
  Pressable,
  StyleSheet,
  Text,
  View,
  type LayoutChangeEvent,
} from 'react-native';

import type {
  CertifiedOpening,
  OpeningCertainty,
  OpeningName,
  OpeningTitle,
} from '@/engine/openingBook';
import { gameAfterWalk, lastStepOfWalk, walkOpeningLine } from '@/engine/openingLine';
import { formatScore } from '@/features/analysis/EvalBar';
import MiniBoard from '@/features/board/MiniBoard';
import { colors, radius, space } from '@/theme';
import type { ModeDefinition, ModeID } from '@/types/game';
import { Badge, Panel } from '@/ui/primitives';

import { ExpectationBar, TurnDot, sideOf, ui } from './openingsUi';

/** The board on a certified card. It drives the card's height. */
const CARD_BOARD = 168;

/**
 * Below this the card stacks: the board on top, the reading under it.
 *
 * A phone's card is about 326pt wide, which leaves 134pt beside a 168pt board
 * -- not enough for three move chips, and they overflowed the card by 122pt
 * rather than wrapping, because a flex row's children do not shrink by
 * default. Measured off the DOM; it is invisible in a screenshot.
 */
const CARD_STACKS_BELOW = 430;

/**
 * The narrowest a card may be before the grid gives it a row to itself.
 *
 * Cards size themselves by flex basis rather than from a measured page width.
 * Measuring the page and dividing produced cards 32px wider than the panel
 * they sit in -- the measurement was the header's width and the cards live
 * inside a padded panel -- and the overflow was invisible until the numbers
 * were read off the DOM.
 */
const CARD_BASIS = 340;

/**
 * Why a line ends, in words a reader can act on.
 *
 * Each of these is a fact about the search rather than an apology for it --
 * "the engine is indifferent between three replies here" tells somebody
 * studying the opening more than a line that carried on regardless would have.
 */
const stopExplanation = (opening: CertifiedOpening): string => {
  switch (opening.stop) {
    case 'indifferent':
      return opening.alternatives > 1
        ? `RPSFish rates ${opening.alternatives} replies equally here, so the opening genuinely branches.`
        : 'RPSFish has no single best reply here, so the opening branches.';
    case 'shallow':
      return 'The next position has not been searched deeply enough to call.';
    case 'frontier':
      return 'The scan has not analyzed the next position yet.';
    case 'decisive':
      return 'The line is already decided from here, which makes it a finished game rather than an opening.';
    case 'repetition':
      return 'The line returns to a position it has already visited.';
    case 'plies':
    default:
      return 'Still certain at the end of the line — the cut here is the length limit, not the analysis.';
  }
};

/** A short label for the same fact, for the badge. */
const stopBadge = (stop: CertifiedOpening['stop']): string => {
  switch (stop) {
    case 'indifferent':
      return 'BRANCHES HERE';
    case 'shallow':
      return 'NEEDS DEPTH';
    case 'frontier':
      return 'FRONTIER';
    case 'decisive':
      return 'DECIDED';
    case 'repetition':
      return 'REPEATS';
    case 'plies':
    default:
      return 'CERTAIN THROUGHOUT';
  }
};

interface CertifiedCardProps {
  mode: ModeDefinition | null;
  modeId: ModeID;
  /** The published name on this exact line, for saying who gave it. */
  named: OpeningName | null;
  onOpen: (line: string[]) => void;
  opening: CertifiedOpening;
  /** Board above the reading rather than beside it. */
  stack: boolean;
  title: OpeningTitle;
}

function CertifiedCard({
  mode,
  modeId,
  named,
  onOpen,
  opening,
  stack,
  title,
}: CertifiedCardProps) {
  const walk = useMemo(
    () => walkOpeningLine(mode, opening.line),
    [mode, opening.line.join(' ')],
  );
  const last = lastStepOfWalk(walk);
  const reached = gameAfterWalk(walk);
  const turn = sideOf(undefined, opening.line.length);

  return (
    <Pressable
      accessibilityLabel={`Open ${title.label}`}
      accessibilityRole="button"
      onPress={() => onOpen(opening.line)}
      style={({ pressed }) => [styles.card, stack && styles.cardStacked, pressed && ui.pressed]}
    >
      {/* The board, not a description of it: this is the position the opening
          produces, which is the thing the card is about. Everything else sits
          beside it and fills the height it sets, so the card has no void on
          its right -- the failure a half-empty panel is. */}
      {reached ? (
        <MiniBoard
          capture={last?.captured}
          grid={reached.grid}
          modeId={modeId}
          move={last?.move}
          mover={last?.mover}
          size={CARD_BOARD}
        />
      ) : (
        <View style={[styles.boardMissing, { height: CARD_BOARD, width: CARD_BOARD }]} />
      )}
      <View style={styles.cardCopy}>
        <View style={styles.cardHeading}>
          <Text style={styles.rank}>#{opening.rank}</Text>
          <Text numberOfLines={2} style={styles.cardTitle}>
            {title.exact || title.inherited ? title.label : 'Unnamed opening'}
          </Text>
        </View>
        <View style={styles.cardFacts}>
          {/* The engine certified the line; it did not choose the name. A
              player's name on a certified opening is worth marking, or the two
              claims read as one. */}
          {named?.source === 'player' ? (
            <Badge
              label={named.authorUsername ? `NAMED BY ${named.authorUsername}` : 'NAMED BY A PLAYER'}
            />
          ) : null}
          <Badge label={`${opening.line.length} PLIES`} tone="accent" />
          <Badge label={`DEPTH ${opening.depth}`} />
          <Badge label={formatScore(opening.value)} tone={opening.value >= 0 ? 'accent' : 'warm'} />
        </View>
        <View style={styles.turnRow}>
          <TurnDot turn={turn} />
          <Text style={styles.turnText}>{turn.toUpperCase()} TO MOVE AT THE END</Text>
        </View>

        <View style={styles.moveRow}>
          {opening.line.map((notation, index) => (
            <View key={`${index}-${notation}`} style={styles.moveChip}>
              <Text style={styles.movePly}>{index + 1}</Text>
              <Text style={styles.moveText}>{notation}</Text>
            </View>
          ))}
        </View>

        {/* What the line is worth, drawn the way the move cards draw it.
            Openings are close by definition, so the bar fills from the middle
            -- and it is here because the column beside a board this size would
            otherwise be half empty, which reads as unfinished. */}
        <View style={styles.expectation}>
          <ExpectationBar modeId={modeId} score={opening.value} turn={turn} />
        </View>

        {/* At the foot of the column, so a two-ply line and an eight-ply one
            both leave the card looking finished. */}
        <View style={styles.stopRow}>
          <Badge
            label={stopBadge(opening.stop)}
            tone={opening.stop === 'plies' ? 'gold' : 'neutral'}
          />
          <Text style={styles.stopText}>{stopExplanation(opening)}</Text>
        </View>
      </View>
    </Pressable>
  );
}

export interface CertifiedOpeningsProps {
  certainty: OpeningCertainty | undefined;
  openings: CertifiedOpening[];
  mode: ModeDefinition | null;
  modeId: ModeID;
  onOpen: (line: string[]) => void;
  nameFor: (line: string[]) => OpeningName | null;
  titleFor: (line: string[]) => OpeningTitle;
}

export default function CertifiedOpenings({
  certainty,
  openings,
  mode,
  modeId,
  onOpen,
  nameFor,
  titleFor,
}: CertifiedOpeningsProps) {
  // The *grid's* width, not the page's. Dividing a page width produced cards
  // wider than the panel holding them, because the page width was measured on
  // the header and the panel is padded.
  const [gridWidth, setGridWidth] = useState(0);
  const measure = (event: LayoutChangeEvent) => setGridWidth(event.nativeEvent.layout.width);
  const stack = gridWidth > 0 && gridWidth < CARD_STACKS_BELOW;

  return (
    <Panel style={styles.panel}>
      <View style={styles.header}>
        <View style={styles.headerCopy}>
          <Text style={ui.eyebrow}>CERTIFIED BY RPSFISH</Text>
          <Text style={styles.sectionTitle}>
            {openings.length === 0
              ? 'Nothing is certified yet'
              : `${openings.length} opening${openings.length === 1 ? '' : 's'} the engine stands behind`}
          </Text>
        </View>
        {/* A book imported before certification existed decodes as a zeroed
            bar rather than an absent one, and "DEPTH 0+" is worse than no
            badge: it states a threshold nobody set. */}
        {certainty && certainty.depth > 0 ? (
          <Badge label={`DEPTH ${certainty.depth}+`} tone="accent" />
        ) : null}
      </View>

      {openings.length === 0 ? (
        <View style={styles.emptyState}>
          <Text style={styles.emptyTitle}>
            {certainty && certainty.depth > 0
              ? 'The scan has not separated this mode’s openings from each other.'
              : 'This book was published before openings were certified.'}
          </Text>
          <Text style={styles.emptyCopy}>
            {certainty && certainty.depth > 0
              ? 'An opening is certified while exactly one continuation is strictly best. Where ' +
                'the engine rates several replies equally, there is no single line to recommend — ' +
                'so this list is empty rather than filled with lines nobody should trust. More ' +
                'search is the answer, not a lower bar. Every position is still explorable below.'
              : 'It carries no certainty measurements, so there is nothing here to stand behind ' +
                'yet — which is not the same as nothing being certain. The next scan will fill ' +
                'this in. Every position is still explorable below.'}
          </Text>
        </View>
      ) : (
        <>
          <Text style={styles.sectionCopy}>
            Each line runs as far as exactly one continuation is strictly best, and stops where
            RPSFish is indifferent. The badge on each card says which of those happened. Tap an
            opening to explore from its final position.
          </Text>
          <View onLayout={measure} style={styles.grid}>
            {openings.map((opening) => (
              <CertifiedCard
                key={opening.line.join(' ')}
                mode={mode}
                modeId={modeId}
                named={nameFor(opening.line)}
                onOpen={onOpen}
                opening={opening}
                stack={stack}
                title={titleFor(opening.line)}
              />
            ))}
          </View>
        </>
      )}
    </Panel>
  );
}

const styles = StyleSheet.create({
  panel: { gap: space.small },
  header: {
    alignItems: 'flex-start',
    flexDirection: 'row',
    gap: space.small,
    justifyContent: 'space-between',
  },
  // minWidth 0 so a long heading wraps instead of pushing the badge off the
  // row: a flex item will not shrink below its longest word without it.
  headerCopy: { flex: 1, gap: 2, minWidth: 0 },
  sectionTitle: { color: colors.text, fontSize: 19, fontWeight: '700' },
  sectionCopy: { color: colors.textMuted, fontSize: 13, lineHeight: 19 },
  // Cards tile by flex basis rather than by a width divided out of a measured
  // page: two per row where two fit, one where they do not, and never wider
  // than the panel holding them.
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: space.medium },
  card: {
    backgroundColor: colors.surfaceRaised,
    borderColor: colors.border,
    borderRadius: radius.medium,
    borderWidth: 1,
    flexBasis: CARD_BASIS,
    flexDirection: 'row',
    flexGrow: 1,
    flexShrink: 1,
    gap: space.small,
    minWidth: 0,
    padding: space.small,
  },
  cardStacked: { alignItems: 'stretch', flexDirection: 'column' },
  boardMissing: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: radius.small,
    borderWidth: 1,
  },
  cardCopy: { flex: 1, gap: 6, minWidth: 0 },
  expectation: { marginTop: 2 },
  cardHeading: { alignItems: 'baseline', flexDirection: 'row', gap: 6 },
  rank: { color: colors.accentBright, fontSize: 13, fontWeight: '800' },
  cardTitle: { color: colors.text, flex: 1, fontSize: 15, fontWeight: '700', minWidth: 0 },
  cardFacts: { flexDirection: 'row', flexWrap: 'wrap', gap: 4 },
  turnRow: { alignItems: 'center', flexDirection: 'row', gap: 5 },
  turnText: { color: colors.textMuted, fontSize: 10, fontWeight: '700', letterSpacing: 0.6 },
  moveRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 4, minWidth: 0 },
  moveChip: {
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderRadius: radius.small,
    flexDirection: 'row',
    gap: 4,
    paddingHorizontal: 6,
    paddingVertical: 3,
  },
  movePly: { color: colors.textFaint, fontSize: 9, fontWeight: '700' },
  moveText: { color: colors.text, fontSize: 12, fontVariant: ['tabular-nums'] },
  stopRow: { alignItems: 'flex-start', flexDirection: 'row', gap: 6, marginTop: 'auto' },
  stopText: { color: colors.textMuted, flex: 1, fontSize: 11, lineHeight: 16, minWidth: 0 },
  emptyState: { gap: 6 },
  emptyTitle: { color: colors.text, fontSize: 15, fontWeight: '700' },
  emptyCopy: { color: colors.textMuted, fontSize: 13, lineHeight: 19 },
});
