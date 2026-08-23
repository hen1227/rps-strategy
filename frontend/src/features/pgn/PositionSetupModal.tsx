import { useEffect, useMemo, useState } from 'react';
import {
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';

import PieceIcon from '@/features/board/PieceIcon';
import { board, colors, overlay, players, radius, shadows } from '@/theme';
import type {
  ModeDefinition,
  Piece,
  SideColor,
  StartingPosition,
} from '@/types/game';

const BOARD_SIZE = 9;
const EMPTY_ROW = '.'.repeat(BOARD_SIZE);
const FILES = 'abcdefghi';

/** One brush in the palette: a piece to place, or the eraser. */
interface SetupTool {
  symbol: string;
  color: SideColor | null;
  piece: Piece;
}

const TOOLS: SetupTool[] = [
  { symbol: 'r', color: 'Red', piece: 'Rock' },
  { symbol: 'p', color: 'Red', piece: 'Paper' },
  { symbol: 's', color: 'Red', piece: 'Scissors' },
  { symbol: 'R', color: 'Blue', piece: 'Rock' },
  { symbol: 'P', color: 'Blue', piece: 'Paper' },
  { symbol: 'S', color: 'Blue', piece: 'Scissors' },
  { symbol: '.', color: null, piece: 'Empty' },
];

/** The placeable tools, by the symbol a row stores them as. */
const PIECES_BY_SYMBOL: Record<string, SetupTool> = Object.fromEntries(
  TOOLS.filter((tool) => tool.color).map((tool) => [tool.symbol, tool]),
);

const normalizeRows = (position: StartingPosition | null | undefined): string[] =>
  Array.from({ length: BOARD_SIZE }, (_, y) => {
    const row = position?.rows?.[y];
    return typeof row === 'string' && row.length === BOARD_SIZE ? row : EMPTY_ROW;
  });

const replaceSymbol = (rows: string[], x: number, y: number, symbol: string) =>
  rows.map((row, rowIndex) =>
    rowIndex === y ? `${row.slice(0, x)}${symbol}${row.slice(x + 1)}` : row,
  );

const countPieces = (rows: string[], symbols: string) =>
  rows.reduce(
    (count, row) => count + Array.from(row).filter((symbol) => symbols.includes(symbol)).length,
    0,
  );

export interface PositionSetupModalProps {
  /** The board to open with. Falls back to the mode's own opening. */
  initialPosition?: StartingPosition | null;
  /** The one mode being edited for, when there is only one. */
  mode?: ModeDefinition | null;
  /** Several modes, when one editor serves a screen that offers a choice. */
  modes?: ModeDefinition[] | null;
  onApply: (position: StartingPosition) => void;
  onClose: () => void;
  title?: string;
  visible: boolean;
}

export default function PositionSetupModal({
  initialPosition,
  mode,
  modes,
  onApply,
  onClose,
  title,
  visible,
}: PositionSetupModalProps) {
  const { width } = useWindowDimensions();
  const [rows, setRows] = useState(() => normalizeRows(initialPosition));
  const [selectedSymbol, setSelectedSymbol] = useState('r');
  const tileSize = Math.max(26, Math.min(38, Math.floor((width - 68) / BOARD_SIZE)));

  // One editor can serve several modes at once, so the restore buttons are
  // built from the distinct openings behind them rather than one per mode.
  const presetModes = useMemo(() => {
    if (modes?.length) return modes;
    return mode ? [mode] : [];
  }, [mode, modes]);
  const presets = useMemo(() => {
    const byLayout = new Map<string, ModeDefinition>();
    presetModes.forEach((candidate) => {
      const layout = normalizeRows(candidate.startingPosition).join('/');
      if (!byLayout.has(layout)) byLayout.set(layout, candidate);
    });
    const distinct = Array.from(byLayout.values());
    return distinct.map((candidate) => ({
      id: candidate.id,
      label: distinct.length > 1 ? `${candidate.name.toUpperCase()} SETUP` : 'MODE SETUP',
      position: candidate.startingPosition,
    }));
  }, [presetModes]);
  const defaultPosition = presetModes[0]?.startingPosition ?? null;

  useEffect(() => {
    if (!visible) return;
    setRows(normalizeRows(initialPosition ?? defaultPosition));
    setSelectedSymbol('r');
  }, [defaultPosition, initialPosition, visible]);

  const counts = useMemo(
    () => ({
      Red: countPieces(rows, 'rps'),
      Blue: countPieces(rows, 'RPS'),
    }),
    [rows],
  );

  if (presetModes.length === 0) return null;

  return (
    <Modal animationType="fade" onRequestClose={onClose} transparent visible={visible}>
      <View style={styles.root}>
        <Pressable
          accessibilityLabel="Close position setup"
          accessibilityRole="button"
          onPress={onClose}
          style={styles.backdrop}
        />
        <View accessibilityViewIsModal style={styles.card}>
          <View style={styles.header}>
            <View style={styles.headerCopy}>
              <Text style={styles.eyebrow}>CUSTOM POSITION</Text>
              <Text style={styles.title}>{title ?? `${presetModes[0].name} setup`}</Text>
              <Text style={styles.subtitle}>Choose a piece, then tap squares to place it.</Text>
            </View>
            <Pressable
              accessibilityLabel="Close position setup"
              accessibilityRole="button"
              onPress={onClose}
              style={({ pressed }) => [styles.closeButton, pressed && styles.pressed]}
            >
              <Text style={styles.closeMark}>×</Text>
            </Pressable>
          </View>

          <ScrollView
            contentContainerStyle={styles.scrollContent}
            showsVerticalScrollIndicator={false}
          >
            <View style={styles.palette}>
              {TOOLS.map((tool) => {
                const selected = selectedSymbol === tool.symbol;
                return (
                  <Pressable
                    accessibilityLabel={
                      tool.color ? `Place ${tool.color} ${tool.piece}` : 'Erase pieces'
                    }
                    accessibilityRole="radio"
                    accessibilityState={{ checked: selected }}
                    key={tool.symbol}
                    onPress={() => setSelectedSymbol(tool.symbol)}
                    style={({ pressed }) => [
                      styles.tool,
                      selected && styles.toolSelected,
                      pressed && styles.pressed,
                    ]}
                  >
                    {tool.color ? (
                      <PieceIcon color={tool.color} piece={tool.piece} size={27} />
                    ) : (
                      <Text style={styles.eraser}>×</Text>
                    )}
                    <Text style={[styles.toolLabel, selected && styles.toolLabelSelected]}>
                      {tool.color ? tool.color.toUpperCase() : 'ERASE'}
                    </Text>
                  </Pressable>
                );
              })}
            </View>

            <View style={styles.boardFrame}>
              {rows.map((row, y) => (
                <View key={`row-${y}`} style={styles.boardRow}>
                  {Array.from(row, (symbol, x) => {
                    const piece = PIECES_BY_SYMBOL[symbol];
                    return (
                      <Pressable
                        accessibilityLabel={`${FILES[x]}${y + 1}${
                          piece ? `, ${piece.color} ${piece.piece}` : ', empty'
                        }`}
                        accessibilityRole="button"
                        key={`${x}:${y}`}
                        onPress={() => setRows((current) => replaceSymbol(current, x, y, selectedSymbol))}
                        style={({ pressed }) => [
                          styles.tile,
                          { width: tileSize, height: tileSize },
                          (x + y) % 2 === 0 ? styles.tileLight : styles.tileDark,
                          piece?.color === 'Red' && styles.tileRed,
                          piece?.color === 'Blue' && styles.tileBlue,
                          pressed && styles.tilePressed,
                        ]}
                      >
                        {piece && (
                          <PieceIcon
                            color={piece.color ?? undefined}
                            piece={piece.piece}
                            size={tileSize - 7}
                          />
                        )}
                      </Pressable>
                    );
                  })}
                </View>
              ))}
            </View>

            <View style={styles.summaryRow}>
              <Text style={[styles.summary, styles.redSummary]}>RED · {counts.Red}</Text>
              <Text style={styles.turnLabel}>RED MOVES FIRST</Text>
              <Text style={[styles.summary, styles.blueSummary]}>BLUE · {counts.Blue}</Text>
            </View>

            <View style={styles.quickActions}>
              {presets.map((preset) => (
                <Pressable
                  accessibilityRole="button"
                  key={preset.id}
                  onPress={() => setRows(normalizeRows(preset.position))}
                  style={({ pressed }) => [styles.secondaryButton, pressed && styles.pressed]}
                >
                  <Text style={styles.secondaryText}>{preset.label}</Text>
                </Pressable>
              ))}
              <Pressable
                accessibilityRole="button"
                onPress={() => setRows(Array(BOARD_SIZE).fill(EMPTY_ROW))}
                style={({ pressed }) => [styles.secondaryButton, pressed && styles.pressed]}
              >
                <Text style={styles.secondaryText}>CLEAR BOARD</Text>
              </Pressable>
            </View>
          </ScrollView>

          <View style={styles.footer}>
            <Pressable
              accessibilityRole="button"
              onPress={onClose}
              style={({ pressed }) => [styles.cancelButton, pressed && styles.pressed]}
            >
              <Text style={styles.cancelText}>CANCEL</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              onPress={() => onApply({ rows })}
              style={({ pressed }) => [styles.applyButton, pressed && styles.pressed]}
            >
              <Text style={styles.applyText}>USE POSITION</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 14 },
  backdrop: { ...StyleSheet.absoluteFill, backgroundColor: overlay },
  card: {
    width: '100%',
    maxWidth: 520,
    maxHeight: '94%',
    padding: 17,
    borderRadius: radius.large,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    backgroundColor: colors.surface,
    boxShadow: shadows.modal,
    elevation: 18,
  },
  header: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  headerCopy: { flex: 1 },
  eyebrow: { color: colors.accentBright, fontSize: 8, fontWeight: '900', letterSpacing: 1.4 },
  title: { color: colors.textStrong, fontSize: 20, fontWeight: '900', marginTop: 4 },
  subtitle: { color: colors.textMuted, fontSize: 10, marginTop: 4 },
  closeButton: {
    width: 34,
    height: 34,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.medium,
    backgroundColor: colors.surfaceRaised,
  },
  closeMark: { color: colors.textMuted, fontSize: 23, lineHeight: 25 },
  scrollContent: { alignItems: 'center', paddingTop: 14, paddingBottom: 4 },
  palette: { flexDirection: 'row', justifyContent: 'center', flexWrap: 'wrap', gap: 6 },
  tool: {
    minWidth: 52,
    height: 48,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 5,
    borderRadius: radius.small,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    backgroundColor: colors.surfaceSunken,
  },
  toolSelected: { borderColor: colors.accent, backgroundColor: colors.accentSurfaceStrong },
  toolLabel: { color: colors.textFaint, fontSize: 6, fontWeight: '900', marginTop: -1 },
  toolLabelSelected: { color: colors.accentSoft },
  eraser: { color: colors.textMuted, fontSize: 27, lineHeight: 27 },
  boardFrame: {
    marginTop: 13,
    padding: 3,
    borderRadius: radius.small,
    backgroundColor: board.frame,
  },
  boardRow: { flexDirection: 'row' },
  tile: { alignItems: 'center', justifyContent: 'center' },
  tileLight: { backgroundColor: board.lightTile },
  tileDark: { backgroundColor: board.darkTile },
  tileRed: { borderWidth: 1, borderColor: players.Red.soft },
  tileBlue: { borderWidth: 1, borderColor: players.Blue.soft },
  tilePressed: { opacity: 0.65 },
  summaryRow: {
    width: '100%',
    maxWidth: 348,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 9,
  },
  summary: { fontSize: 8, fontWeight: '900' },
  redSummary: { color: players.Red.strong },
  blueSummary: { color: players.Blue.strong },
  turnLabel: { color: colors.textFaint, fontSize: 7, fontWeight: '900' },
  quickActions: { flexDirection: 'row', gap: 8, marginTop: 13 },
  secondaryButton: {
    minHeight: 34,
    justifyContent: 'center',
    paddingHorizontal: 11,
    borderRadius: radius.small,
    borderWidth: 1,
    borderColor: colors.borderStrong,
  },
  secondaryText: { color: colors.textMuted, fontSize: 8, fontWeight: '900' },
  footer: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8, marginTop: 14 },
  cancelButton: { minHeight: 40, justifyContent: 'center', paddingHorizontal: 14 },
  cancelText: { color: colors.textMuted, fontSize: 9, fontWeight: '900' },
  applyButton: {
    minHeight: 40,
    justifyContent: 'center',
    paddingHorizontal: 17,
    borderRadius: radius.medium,
    backgroundColor: colors.accent,
  },
  applyText: { color: colors.textStrong, fontSize: 9, fontWeight: '900' },
  pressed: { opacity: 0.7 },
});
