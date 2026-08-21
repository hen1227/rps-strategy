import { StyleSheet, Text, View } from 'react-native';

import PieceIcon from './PieceIcon';
import { colors } from '../theme';

const PIECE_ORDER = ['Rock', 'Paper', 'Scissors'];

// Mirrors the mode layout language documented in the backend's
// StartingPosition: uppercase is Blue, lowercase is Red.
const STARTING_SYMBOLS = {
  R: { color: 'Blue', piece: 'Rock' },
  P: { color: 'Blue', piece: 'Paper' },
  S: { color: 'Blue', piece: 'Scissors' },
  r: { color: 'Red', piece: 'Rock' },
  p: { color: 'Red', piece: 'Paper' },
  s: { color: 'Red', piece: 'Scissors' },
};

const PIECE_SIZE = 22;

const emptyTally = () => ({ Rock: 0, Paper: 0, Scissors: 0 });

const totalOf = (tally) =>
  PIECE_ORDER.reduce((total, piece) => total + tally[piece], 0);

// No mode promotes or spawns pieces, so anything a side started with and no
// longer has on the board was captured by the opponent. That keeps the tray
// correct for spectators and rejoins, which never saw the moves themselves.
export const capturedPieces = (gameState) => {
  const start = { Red: emptyTally(), Blue: emptyTally() };
  for (const row of gameState?.mode?.startingPosition?.rows ?? []) {
    for (const symbol of row) {
      const entry = STARTING_SYMBOLS[symbol];
      if (entry) start[entry.color][entry.piece] += 1;
    }
  }

  const remaining = { Red: emptyTally(), Blue: emptyTally() };
  for (const row of gameState?.grid ?? []) {
    for (const tile of row) {
      const side = remaining[tile.occupantOwner];
      if (side && side[tile.occupant] !== undefined) side[tile.occupant] += 1;
    }
  }

  const lossesFor = (color) =>
    PIECE_ORDER.reduce((tally, piece) => {
      tally[piece] = Math.max(0, start[color][piece] - remaining[color][piece]);
      return tally;
    }, emptyTally());

  const redLosses = lossesFor('Red');
  const blueLosses = lossesFor('Blue');
  const takenByRed = totalOf(blueLosses);
  const takenByBlue = totalOf(redLosses);

  return {
    Red: { tally: blueLosses, count: takenByRed, advantage: takenByRed - takenByBlue },
    Blue: { tally: redLosses, count: takenByBlue, advantage: takenByBlue - takenByRed },
  };
};

// `color` is the side the captured pieces belonged to, so the tray beside a
// player's clock shows the enemy material they have taken off the board.
export default function CapturedPieces({ advantage = 0, color, tally }) {
  const groups = PIECE_ORDER.filter((piece) => (tally?.[piece] ?? 0) > 0);
  if (groups.length === 0) return null;

  const summary = groups
    .map((piece) => `${tally[piece]} ${piece.toLowerCase()}`)
    .join(', ');

  return (
    <View
      accessibilityLabel={`Captured ${color} pieces: ${summary}${
        advantage > 0 ? `, ahead by ${advantage}` : ''
      }`}
      style={styles.tray}
    >
      {groups.map((piece) => (
        <View key={piece} style={styles.group}>
          {Array.from({ length: tally[piece] }, (_, index) => (
            <View key={index} style={index > 0 && styles.stacked}>
              <PieceIcon piece={piece} color={color} size={PIECE_SIZE} />
            </View>
          ))}
        </View>
      ))}
      {advantage > 0 && <Text style={styles.advantage}>+{advantage}</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  tray: {
    flexShrink: 1,
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: 4,
    marginRight: 5,
  },
  group: { flexDirection: 'row', alignItems: 'center' },
  // Chess.com fans a group of like pieces out from a single stack.
  stacked: { marginLeft: -PIECE_SIZE * 0.45 },
  advantage: {
    color: colors.textMuted,
    fontSize: 11,
    fontWeight: '800',
    fontVariant: ['tabular-nums'],
  },
});
