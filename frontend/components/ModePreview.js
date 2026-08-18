import { StyleSheet, Text, View } from 'react-native';

const BOARD_SIZE = 9;

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
  R: { owner: 'blue', piece: 'R' },
  P: { owner: 'blue', piece: 'P' },
  S: { owner: 'blue', piece: 'S' },
  r: { owner: 'red', piece: 'R' },
  p: { owner: 'red', piece: 'P' },
  s: { owner: 'red', piece: 'S' },
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
                  {piece && (
                    <View
                      style={[
                        styles.piece,
                        piece.owner === 'red' ? styles.redPiece : styles.bluePiece,
                      ]}
                    >
                      <Text style={styles.pieceText}>{piece.piece}</Text>
                    </View>
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
    borderRadius: 11,
    backgroundColor: '#1f1e1b',
    borderWidth: 1,
    borderColor: '#45433f',
  },
  previewHeader: {
    height: 12,
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 6,
  },
  previewDot: { width: 5, height: 5, borderRadius: 3, backgroundColor: '#81b64c' },
  previewLine: {
    width: 20,
    height: 3,
    marginLeft: 5,
    borderRadius: 2,
    backgroundColor: '#53514c',
  },
  previewLabel: {
    marginLeft: 'auto',
    color: '#8f8c86',
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
    borderColor: '#171613',
  },
  row: { flex: 1, flexDirection: 'row' },
  square: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  squareLight: { backgroundColor: '#d7c5a3' },
  squareDark: { backgroundColor: '#769656' },
  redTerritory: { backgroundColor: '#a85d52' },
  blueTerritory: { backgroundColor: '#527da1' },
  piece: {
    width: '76%',
    aspectRatio: 1,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 20,
    borderWidth: 0.75,
  },
  redPiece: { backgroundColor: '#c84b44', borderColor: '#ffe0d2' },
  bluePiece: { backgroundColor: '#3f77aa', borderColor: '#d8ecff' },
  pieceText: { color: '#ffffff', fontSize: 5, fontWeight: '900' },
});
