import { StyleSheet, Text, View } from 'react-native';

import PieceIcon from './PieceIcon';
import { board, colors, players, radius } from '../theme';

const BOARD_SIZE = 9;
const MODE_INFILTRATION = 'V3';

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

const PIECES_BY_SYMBOL = {
  R: { owner: 'blue', piece: 'Rock' },
  P: { owner: 'blue', piece: 'Paper' },
  S: { owner: 'blue', piece: 'Scissors' },
  r: { owner: 'red', piece: 'Rock' },
  p: { owner: 'red', piece: 'Paper' },
  s: { owner: 'red', piece: 'Scissors' },
};

// The preview board is a fixed 116pt wide with 8pt of padding around it.
const PREVIEW_PIECE_SIZE = 11;

// Mirrors tintForTile in Board.js: in Infiltration the far ranks are the goal
// each side is running at, so the thumbnail marks them the same way.
const goalOwnerFor = (modeId, y) => {
  if (modeId !== MODE_INFILTRATION) return null;
  if (y === 0) return 'red';
  if (y === BOARD_SIZE - 1) return 'blue';
  return null;
};

const keyFor = (x, y) => `${x}:${y}`;

const validRows = (rows) =>
  Array.isArray(rows) &&
  rows.length === BOARD_SIZE &&
  rows.every((row) => typeof row === 'string' && row.length === BOARD_SIZE);

export default function ModePreview({ mode }) {
  const rows = validRows(mode?.startingPosition?.rows)
    ? mode.startingPosition.rows
    : DEFAULT_ROWS;
  const showsTerritory = mode?.features?.includes('territory');

  return (
    <View style={styles.frame} accessibilityElementsHidden>
      <View style={styles.previewHeader}>
        <View style={styles.previewDot} />
        <View style={styles.previewLine} />
        <Text style={styles.previewLabel}>START</Text>
      </View>
      <View style={styles.board}>
        {Array.from({ length: BOARD_SIZE }, (_, y) => (
          <View key={`row-${y}`} style={styles.row}>
            {Array.from({ length: BOARD_SIZE }, (_, x) => {
              const key = keyFor(x, y);
              const piece = PIECES_BY_SYMBOL[rows[y][x]];
              const goalOwner = goalOwnerFor(mode?.id, y);
              return (
                <View
                  key={key}
                  style={[
                    styles.square,
                    (x + y) % 2 === 0 ? styles.squareLight : styles.squareDark,
                    showsTerritory && piece?.owner === 'red' && styles.redTerritory,
                    showsTerritory && piece?.owner === 'blue' && styles.blueTerritory,
                  ]}
                >
                  {goalOwner && (
                    <View
                      style={[
                        styles.goalTint,
                        goalOwner === 'red' ? styles.redGoalTint : styles.blueGoalTint,
                      ]}
                    />
                  )}
                  {piece && (
                    <PieceIcon
                      piece={piece.piece}
                      color={piece.owner === 'red' ? 'Red' : 'Blue'}
                      size={PREVIEW_PIECE_SIZE}
                    />
                  )}
                </View>
              );
            })}
          </View>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  frame: {
    width: 116,
    padding: 8,
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
  board: {
    width: '100%',
    aspectRatio: 1,
    overflow: 'hidden',
    borderRadius: 4,
    borderWidth: 1,
    borderColor: board.frame,
  },
  row: { flex: 1, flexDirection: 'row' },
  square: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  squareLight: { backgroundColor: board.lightTile },
  squareDark: { backgroundColor: board.darkTile },
  redTerritory: { backgroundColor: players.Red.territory },
  blueTerritory: { backgroundColor: players.Blue.territory },
  goalTint: {
    ...StyleSheet.absoluteFillObject,
    borderWidth: 0.5,
    borderColor: board.goalOutline,
  },
  redGoalTint: { backgroundColor: players.Red.tint },
  blueGoalTint: { backgroundColor: players.Blue.tint },
});
