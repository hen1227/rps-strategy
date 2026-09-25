import { StyleSheet, Text, View } from 'react-native';

import PieceIcon from './PieceIcon';
import { colors, themedSheet } from '@/theme';
import {
  PLAYABLE_PIECES,
  type Grid,
  type ModeDefinition,
  type PlayablePiece,
  type SideColor,
} from '@/types/game';

const PIECE_ORDER = PLAYABLE_PIECES;

/** How many of each piece a side has, or has lost. */
export type PieceTally = Record<PlayablePiece, number>;

/** What one side has taken off the board. */
export interface CaptureTray {
  tally: PieceTally;
  count: number;
  /** How far ahead this side is on captures. */
  advantage: number;
}

// Mirrors the mode layout language documented in the backend's
// StartingPosition: uppercase is Blue, lowercase is Red.
const STARTING_SYMBOLS: Record<string, { color: SideColor; piece: PlayablePiece }> = {
  R: { color: 'Blue', piece: 'Rock' },
  P: { color: 'Blue', piece: 'Paper' },
  S: { color: 'Blue', piece: 'Scissors' },
  r: { color: 'Red', piece: 'Rock' },
  p: { color: 'Red', piece: 'Paper' },
  s: { color: 'Red', piece: 'Scissors' },
};

const PIECE_SIZE = 22;
/** How tall a one-line tray is, for a caller that keeps room for one. */
export const TRAY_HEIGHT = PIECE_SIZE;

const emptyTally = (): PieceTally => ({ Rock: 0, Paper: 0, Scissors: 0 });

const totalOf = (tally: PieceTally) =>
  PIECE_ORDER.reduce((total, piece) => total + tally[piece], 0);

// No mode promotes or spawns pieces, so anything a side started with and no
// longer has on the board was captured by the opponent. That keeps the tray
// correct for spectators and rejoins, which never saw the moves themselves.
/**
 * The least a board needs for its captures to be counted: what is on it, and
 * what the mode started with. A live game, a bot game and a replayed position
 * all satisfy it.
 */
export interface CountableBoard {
  grid: Grid;
  mode: Pick<ModeDefinition, 'startingPosition'>;
}

export const capturedPieces = (
  gameState: CountableBoard | null | undefined,
): Record<SideColor, CaptureTray> => {
  const start: Record<SideColor, PieceTally> = { Red: emptyTally(), Blue: emptyTally() };
  for (const row of gameState?.mode?.startingPosition?.rows ?? []) {
    for (const symbol of row) {
      const entry = STARTING_SYMBOLS[symbol];
      if (entry) start[entry.color][entry.piece] += 1;
    }
  }

  const remaining: Record<SideColor, PieceTally> = { Red: emptyTally(), Blue: emptyTally() };
  for (const row of gameState?.grid ?? []) {
    for (const tile of row) {
      if (tile.occupantOwner === 'Neutral' || tile.occupant === 'Empty') continue;
      remaining[tile.occupantOwner][tile.occupant] += 1;
    }
  }

  const lossesFor = (color: SideColor) =>
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
export interface CapturedPiecesProps {
  advantage?: number;
  /** The side the captured pieces belonged to. */
  color: SideColor;
  tally: PieceTally | null | undefined;
}

export default function CapturedPieces({ advantage = 0, color, tally }: CapturedPiecesProps) {
  const groups = PIECE_ORDER.filter((piece) => (tally?.[piece] ?? 0) > 0);
  if (groups.length === 0) return null;

  const summary = groups
    .map((piece) => `${tally?.[piece] ?? 0} ${piece.toLowerCase()}`)
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
          {Array.from({ length: tally?.[piece] ?? 0 }, (_unused, index) => (
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

const styles = themedSheet(() => ({
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
}));
