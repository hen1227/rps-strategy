import type { ReactNode } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { ModeDefinition, PlayablePiece, SideColor } from '@/types/game';

import ModePreview from './ModePreview';
import PieceIcon from '@/features/board/PieceIcon';
import TileMark from '@/features/board/TileMark';
import { board, colors, players, radius } from '@/theme';
import ModalCard from '@/ui/ModalCard';

// Small rules card for a single mode. Everything the two playable modes share
// lives in the constants below; only the win condition is looked up per mode,
// with a fallback so a newly registered mode still opens something sensible.

const MATCHUPS: { winner: PlayablePiece; loser: PlayablePiece }[] = [
  { winner: 'Rock', loser: 'Scissors' },
  { winner: 'Scissors', loser: 'Paper' },
  { winner: 'Paper', loser: 'Rock' },
];

// Diagram symbols follow the backend's starting-position notation: uppercase is
// Blue, lowercase is Red, '.' is empty. '*' marks a legal destination and
// '#'/'+' an empty tile already claimed by Red/Blue.
const PIECES_BY_SYMBOL: Record<string, { owner: SideColor; piece: PlayablePiece }> = {
  R: { owner: 'Blue', piece: 'Rock' },
  P: { owner: 'Blue', piece: 'Paper' },
  S: { owner: 'Blue', piece: 'Scissors' },
  r: { owner: 'Red', piece: 'Rock' },
  p: { owner: 'Red', piece: 'Paper' },
  s: { owner: 'Red', piece: 'Scissors' },
};

const OWNERS_BY_SYMBOL: Record<string, SideColor> = { '#': 'Red', '+': 'Blue' };

const MOVEMENT_ROWS = ['***', '*r*', '***'];

/** The diagram and caption that explain how one mode is won. */
interface WinCondition {
  rows: string[];
  territory?: boolean;
  goalRow?: number;
  topLabel?: string;
  caption: string;
}

// Keyed by mode id, the same way ModePreview keys its goal tints.
const WIN_CONDITIONS: Record<string, WinCondition> = {
  // Total War: the trail behind each piece is the point, so the diagram shows
  // both sides having painted their way toward the middle.
  V5: {
    rows: ['.+...', '.S...', '...r.', '..##.'],
    territory: true,
    caption:
      'Every square you land on turns your colour for good. Take all of their pieces to win — or own more of the board once no neutral squares are left.',
  },
  // Infiltration: the tinted rank is the finish line, one step above the runner.
  V3: {
    rows: ['..*..', '..r..', '.....'],
    goalRow: 0,
    topLabel: 'THEIR BOUNDARY',
    caption:
      'Land any piece on their far row and you win on the spot. They are racing for yours too, so every attacker you send is one less defender.',
  },
};

const fallbackWinCondition = (mode: ModeDefinition | null | undefined): WinCondition => ({
  rows: ['.....', '..r..', '.....'],
  caption: mode?.objective ?? 'Follow the objective shown on the mode card.',
});

interface MiniBoardProps {
  /** The rank to mark as a goal, when the mode has one. */
  goalRow?: number | null;
  rows: string[];
  territory?: boolean;
  tileSize?: number;
}

function MiniBoard({ goalRow = null, rows, territory = false, tileSize = 26 }: MiniBoardProps) {
  return (
    <View style={styles.miniBoard} accessibilityElementsHidden>
      {rows.map((row, y) => (
        <View key={`row-${y}`} style={styles.miniRow}>
          {Array.from(row, (symbol, x) => {
            const piece = PIECES_BY_SYMBOL[symbol];
            const owner: SideColor | undefined =
              OWNERS_BY_SYMBOL[symbol] ?? (territory ? piece?.owner : undefined);
            return (
              <View
                key={`${x}:${y}`}
                style={[
                  styles.miniTile,
                  { width: tileSize, height: tileSize },
                  (x + y) % 2 === 0 ? styles.tileLight : styles.tileDark,
                  owner === 'Red' && styles.tileRedOwned,
                  owner === 'Blue' && styles.tileBlueOwned,
                ]}
              >
                {goalRow === y && (
                  <>
                    <View style={styles.goalTint} />
                    <TileMark compact owner="Red" variant="goal" />
                  </>
                )}
                {owner && <TileMark compact owner={owner} variant="territory" />}
                {piece ? (
                  <PieceIcon color={piece.owner} piece={piece.piece} size={tileSize - 7} />
                ) : null}
                {symbol === '*' && <View style={styles.moveDot} />}
              </View>
            );
          })}
        </View>
      ))}
    </View>
  );
}

function Section({ children, title }: { children?: ReactNode; title: string }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {children}
    </View>
  );
}

function PieceChip({ color, piece }: { color: SideColor; piece: PlayablePiece }) {
  return (
    <View style={styles.pieceChip}>
      <PieceIcon color={color} piece={piece} size={22} />
      <Text style={styles.pieceChipText}>{piece}</Text>
    </View>
  );
}

export interface HowToPlayModalProps {
  mode: ModeDefinition | null | undefined;
  onClose: () => void;
  visible: boolean;
}

export default function HowToPlayModal({ mode, onClose, visible }: HowToPlayModalProps) {
  if (!mode) return null;

  const win = WIN_CONDITIONS[mode.id] ?? fallbackWinCondition(mode);

  return (
    <ModalCard
      closeLabel="Close how to play"
      eyebrow="HOW TO PLAY"
      footer={
        <Pressable
          accessibilityLabel="Close how to play"
          accessibilityRole="button"
          onPress={onClose}
          style={({ pressed }) => [styles.doneButton, pressed && styles.pressed]}
        >
          <Text style={styles.doneText}>GOT IT</Text>
        </Pressable>
      }
      maxWidth={420}
      onClose={onClose}
      title={mode.name}
      visible={visible}
    >

          <ScrollView
            contentContainerStyle={styles.scrollContent}
            showsVerticalScrollIndicator={false}
            style={styles.scroll}
          >
            <View style={styles.setupRow}>
              <ModePreview mode={mode} />
              <View style={styles.setupCopy}>
                <Text style={styles.setupLabel}>THE SETUP</Text>
                <Text style={styles.body}>
                  A 9×9 board, nine pieces each, nothing hidden. You take one turn at a
                  time and Red starts.
                </Text>
              </View>
            </View>

            <Section title="WHAT BEATS WHAT">
              <View style={styles.matchups}>
                {MATCHUPS.map((matchup) => (
                  <View key={matchup.winner} style={styles.matchupRow}>
                    <PieceChip color="Red" piece={matchup.winner} />
                    <Text style={styles.beats}>beats</Text>
                    <PieceChip color="Blue" piece={matchup.loser} />
                  </View>
                ))}
              </View>
            </Section>

            <Section title="MOVING AND CAPTURING">
              <View style={styles.diagramRow}>
                <MiniBoard rows={MOVEMENT_ROWS} tileSize={30} />
                <Text style={[styles.body, styles.diagramCopy]}>
                  One tile per turn, in any of the eight directions. You can only capture
                  a neighbour your piece beats.
                </Text>
              </View>
            </Section>

            <Section title="HOW TO WIN">
              <View style={styles.diagramRow}>
                <View>
                  {Boolean(win.topLabel) && <Text style={styles.diagramLabel}>{win.topLabel}</Text>}
                  <MiniBoard
                    goalRow={win.goalRow ?? null}
                    rows={win.rows}
                    territory={Boolean(win.territory)}
                  />
                </View>
                <Text style={[styles.body, styles.diagramCopy]}>{win.caption}</Text>
              </View>
            </Section>

            <Text style={styles.footnote}>
              No legal move, or the same position three times over, is a draw. You can also
              offer a draw or resign from the game screen.
            </Text>
      </ScrollView>
    </ModalCard>
  );
}

const styles = StyleSheet.create({


  scroll: { marginTop: 4 },
  scrollContent: { paddingTop: 12, paddingBottom: 4 },

  setupRow: { flexDirection: 'row', alignItems: 'center', gap: 13 },
  setupCopy: { flex: 1 },
  setupLabel: {
    color: colors.textFaint,
    fontSize: 8,
    fontWeight: '900',
    letterSpacing: 1.1,
    marginBottom: 5,
  },
  body: { color: colors.textMuted, fontSize: 11, lineHeight: 17 },

  section: { marginTop: 15 },
  sectionTitle: {
    color: colors.text,
    fontSize: 9,
    fontWeight: '900',
    letterSpacing: 1.1,
    marginBottom: 9,
  },

  matchups: { gap: 6 },
  matchupRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    padding: 6,
    borderRadius: radius.medium,
    backgroundColor: colors.surfaceSunken,
  },
  pieceChip: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 7 },
  pieceChipText: { color: colors.text, fontSize: 11, fontWeight: '800' },
  beats: {
    color: colors.textFaint,
    fontSize: 9,
    fontWeight: '900',
    letterSpacing: 0.6,
    textAlign: 'center',
  },

  diagramRow: { flexDirection: 'row', alignItems: 'center', gap: 13 },
  diagramCopy: { flex: 1 },
  diagramLabel: {
    color: colors.dangerSoft,
    fontSize: 7,
    fontWeight: '900',
    letterSpacing: 0.9,
    marginBottom: 4,
    textAlign: 'center',
  },

  miniBoard: {
    alignSelf: 'flex-start',
    overflow: 'hidden',
    borderRadius: radius.small,
    borderWidth: 1,
    borderColor: board.frame,
  },
  miniRow: { flexDirection: 'row' },
  miniTile: { alignItems: 'center', justifyContent: 'center' },
  // Board palette, kept in step with Board.js and ModePreview.
  tileLight: { backgroundColor: board.lightTile },
  tileDark: { backgroundColor: board.darkTile },
  tileRedOwned: { backgroundColor: players.Red.territory },
  tileBlueOwned: { backgroundColor: players.Blue.territory },
  goalTint: {
    ...StyleSheet.absoluteFill,
    backgroundColor: players.Red.tint,
    borderWidth: 0.5,
    borderColor: board.goalOutline,
  },
  moveDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: board.moveHint,
  },

  footnote: {
    color: colors.textFaint,
    fontSize: 10,
    lineHeight: 16,
    marginTop: 15,
  },

  doneButton: {
    flex: 1,
    minHeight: 42,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 14,
    borderRadius: radius.medium,
    backgroundColor: colors.accent,
  },
  doneText: { color: colors.textStrong, fontSize: 10, fontWeight: '900', letterSpacing: 0.9 },

  pressed: { opacity: 0.7 },
});
