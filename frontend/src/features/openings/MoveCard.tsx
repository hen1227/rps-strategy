// One candidate move, as a board you can walk into.
//
// The grid of these is the book: a position's ranked replies, each drawn where
// it lands, captioned with what the engine thinks and what people call it. A
// card that has no name yet says how many names are waiting for one, because
// "unnamed" and "unnamed, and three people have already proposed something"
// are different invitations.

import { StyleSheet, Text, View, Pressable } from 'react-native';

import { formatScore } from '@/features/analysis/EvalBar';
import MiniBoard from '@/features/board/MiniBoard';
import type { OpeningStep } from '@/engine/openingLine';
import { colors, radius, themedSheet } from '@/theme';
import type { ModeID, SideColor } from '@/types/game';

import { ExpectationBar, TurnDot, forcedLabel } from './openingsUi';

/** The gap between cards, which the grid and the width maths both need. */
export const MOVE_CARD_GAP = 10;
const CARD_PADDING = 9;
const MOVE_CARD_MIN = 186;
const MOVE_CARD_MIN_NARROW = 150;
const MOVE_CARD_MAX = 250;

/**
 * How wide one move card should be, given the room the grid has.
 *
 * Cards are square-ish boards with a caption, so they tile: fit as many whole
 * columns as will hold a legible board, then share the row out between them so
 * the grid has no ragged right edge.
 *
 * A phone has room for one card at the desktop minimum, which would make a
 * book of twenty-three first moves nine thousand pixels long. Two smaller
 * boards halve that and stay legible; the arrow is the thing that has to
 * survive, and it does.
 */
export const moveCardWidthFor = (available: number, narrow: boolean) => {
  if (available <= 0) return 0;
  const smallest = narrow ? MOVE_CARD_MIN_NARROW : MOVE_CARD_MIN;
  const columns = Math.max(1, Math.floor((available + MOVE_CARD_GAP) / (smallest + MOVE_CARD_GAP)));
  const width = (available - MOVE_CARD_GAP * (columns - 1)) / columns;
  return Math.floor(Math.min(width, columns === 1 ? available : MOVE_CARD_MAX));
};

export interface MoveCardProps {
  /** The board this move produces, when the rules could replay it. */
  after: OpeningStep | null;
  childName: string;
  isMainLine: boolean;
  modeId: ModeID;
  move: string;
  nameWanted: boolean;
  onOpen: () => void;
  rank: number;
  score: number;
  status: string;
  /** How many names are waiting on the line this move starts. */
  suggested: number;
  turn: SideColor;
  width: number;
}

export default function MoveCard({
  after,
  childName,
  isMainLine,
  modeId,
  move,
  nameWanted,
  onOpen,
  rank,
  score,
  status,
  suggested,
  turn,
  width,
}: MoveCardProps) {
  const boardSize = width - CARD_PADDING * 2;
  const forced = forcedLabel(score);

  return (
    <Pressable
      accessibilityLabel={`Explore ${move}, ${childName}`}
      accessibilityRole="button"
      onPress={onOpen}
      style={({ pressed }) => [
        styles.moveCard,
        { width },
        isMainLine && styles.moveCardMain,
        pressed && styles.moveCardPressed,
      ]}
    >
      <View style={[styles.moveBoard, { height: boardSize, width: boardSize }]}>
        {after ? (
          <MiniBoard
            capture={after.captured}
            grid={after.game.grid}
            modeId={modeId}
            move={after.move}
            mover={after.mover}
            size={boardSize}
          />
        ) : (
          <View style={styles.moveBoardMissing}>
            <Text style={styles.moveBoardMissingText}>{move}</Text>
          </View>
        )}
        <View style={styles.rankChip}>
          <Text style={styles.rankNumber}>{rank}</Text>
        </View>
        {isMainLine && (
          <View style={styles.mainFlag}>
            <Text style={styles.mainFlagText}>MAIN</Text>
          </View>
        )}
      </View>

      <ExpectationBar modeId={modeId} score={score} turn={turn} />

      <View style={styles.moveHeadline}>
        <TurnDot turn={turn} />
        <Text style={styles.moveNotation}>{move}</Text>
        <Text style={[styles.moveScore, forced && styles.moveScoreForced]}>
          {forced ?? formatScore(score)}
        </Text>
      </View>
      <Text numberOfLines={2} style={[styles.moveName, nameWanted && styles.moveNameWanted]}>
        {childName}
      </Text>
      <Text numberOfLines={2} style={styles.moveStatus}>
        {suggested > 0 && nameWanted
          ? `${suggested} name${suggested === 1 ? '' : 's'} waiting · ${status}`
          : status}
      </Text>
    </Pressable>
  );
}

const styles = themedSheet(() => ({
  moveCard: {
    padding: CARD_PADDING,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.large,
    backgroundColor: colors.surface,
  },
  moveCardMain: { borderColor: colors.goldBorder },
  moveCardPressed: { borderColor: colors.accentBorder, backgroundColor: colors.accentSurfaceQuiet },
  moveBoard: { position: 'relative' },
  moveBoardMissing: {
    ...StyleSheet.absoluteFill,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 4,
    backgroundColor: colors.surfaceSunken,
  },
  moveBoardMissingText: { color: colors.textFaint, fontSize: 13, fontWeight: '900' },
  rankChip: {
    position: 'absolute',
    top: 5,
    left: 5,
    minWidth: 19,
    alignItems: 'center',
    paddingHorizontal: 4,
    paddingVertical: 2,
    borderRadius: radius.small,
    backgroundColor: colors.surfaceDeep,
  },
  rankNumber: { color: colors.textStrong, fontSize: 10, fontWeight: '900' },
  mainFlag: {
    position: 'absolute',
    top: 5,
    right: 5,
    paddingHorizontal: 5,
    paddingVertical: 2,
    borderRadius: radius.small,
    backgroundColor: colors.goldSurfaceDeep,
  },
  mainFlagText: { color: colors.goldBright, fontSize: 7, fontWeight: '900', letterSpacing: 0.8 },
  moveHeadline: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 8 },
  moveNotation: { flex: 1, minWidth: 0, color: colors.textStrong, fontSize: 15, fontWeight: '900' },
  moveScore: {
    color: colors.textSubtle,
    fontSize: 11,
    fontWeight: '900',
    fontVariant: ['tabular-nums'],
  },
  moveScoreForced: { color: colors.goldBright, fontSize: 9 },
  moveName: { color: colors.accentSoft, fontSize: 11, fontWeight: '800', marginTop: 5 },
  moveNameWanted: { color: colors.goldSoft },
  moveStatus: { color: colors.textFaint, fontSize: 9, lineHeight: 13, marginTop: 4 },
}));
