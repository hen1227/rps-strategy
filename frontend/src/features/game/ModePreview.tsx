import { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { gridFromRows } from '@/engine/analysisGame';
import MiniBoard from '@/features/board/MiniBoard';
import { colors, radius } from '@/theme';
import { isBoardRows, type ModeDefinition, type StartingPosition } from '@/types/game';

const DEFAULT_ROWS = [
  'R.P.S.P.R',
  '.S.R.P.S.',
  '.........',
  '.........',
  '.........',
  '.........',
  '.........',
  '.s.p.r.s.',
  'r.p.s.p.r',
];

// The default preview board, and the piece size that reads well inside it.
// A smaller board scales the pieces with it rather than keeping them large,
// which would turn nine ranks into one dark smudge.
const PREVIEW_SIZE = 116;
const PREVIEW_PIECE_SIZE = 11;
const FRAME_PADDING = 8;

const pieceSizeFor = (size: number) =>
  Math.max(5, Math.round((size * PREVIEW_PIECE_SIZE) / PREVIEW_SIZE));

export interface ModePreviewProps {
  mode: ModeDefinition | null | undefined;
  /**
   * The board to draw, when it is not the mode's own. This is what makes the
   * thumbnail work for a custom game: the mode still decides the tinting and
   * the goal ranks, and the pieces are wherever the setup put them.
   */
  position?: StartingPosition | null;
  /** Frame width in points. The board is square inside it. */
  size?: number;
}

export default function ModePreview({ mode, position, size = PREVIEW_SIZE }: ModePreviewProps) {
  const custom = isBoardRows(position?.rows) ? position.rows : null;
  const rows = custom ?? (isBoardRows(mode?.startingPosition?.rows)
    ? mode.startingPosition.rows
    : DEFAULT_ROWS);
  const grid = useMemo(() => gridFromRows(rows), [rows.join('/')]);

  return (
    <View style={[styles.frame, { width: size }]} accessibilityElementsHidden>
      <View style={styles.previewHeader}>
        <View style={styles.previewDot} />
        <View style={styles.previewLine} />
        <Text style={styles.previewLabel}>START</Text>
      </View>
      <MiniBoard
        grid={grid}
        modeId={mode?.id}
        pieceSize={pieceSizeFor(size)}
        size={size - FRAME_PADDING * 2}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  frame: {
    padding: FRAME_PADDING,
    borderRadius: radius.large,
    backgroundColor: colors.surfaceWell,
    borderWidth: 1,
    borderColor: colors.border,
  },
  previewHeader: {
    height: 12,
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 6,
  },
  previewDot: { width: 5, height: 5, borderRadius: 3, backgroundColor: colors.accent },
  previewLine: {
    width: 20,
    height: 3,
    marginLeft: 5,
    borderRadius: 2,
    backgroundColor: colors.borderFaint,
  },
  previewLabel: {
    marginLeft: 'auto',
    color: colors.textDim,
    fontSize: 5,
    fontWeight: '800',
    letterSpacing: 0.8,
  },
});
