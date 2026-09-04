import { useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native';

import { alphabetOf } from '@/engine/analysisGame';
import type { PieceLook } from '@/features/board/pieceLook';
import PieceIcon from '@/features/board/PieceIcon';
import { board, colors, players, radius } from '@/theme';
import ModalCard from '@/ui/ModalCard';
import {
  BOARD_SIZE,
  isBoardRows,
  type ModeDefinition,
  type Piece,
  type SideColor,
  type StartingPosition,
} from '@/types/game';

// The editor's board is the shape of the mode being edited for, not a constant.
// A custom position has to be the same board the mode is played on — see
// `GameSetup.ValidateFor` in the backend — so the shape is taken from that
// mode's own opening and never chosen here.
const FILES = 'abcdefghijklmnopqrstuvwxyz';

interface BoardShape {
  columns: number;
  rows: number;
}

const shapeOf = (position: StartingPosition | null | undefined): BoardShape => {
  const rows = position?.rows;
  if (!isBoardRows(rows)) return { columns: BOARD_SIZE, rows: BOARD_SIZE };
  return { columns: rows[0]?.length ?? BOARD_SIZE, rows: rows.length };
};

const emptyRows = ({ columns, rows }: BoardShape) =>
  Array.from({ length: rows }, () => '.'.repeat(columns));

/** One brush in the palette: a piece to place, or the eraser. */
interface SetupTool {
  symbol: string;
  color: SideColor | null;
  piece: Piece;
  /** What the mode says this kind is drawn as; absent for the built-ins. */
  look?: PieceLook;
  /** What to call it out loud, which is the mode's name for it. */
  name: string;
}

const ERASER: SetupTool = { symbol: '.', color: null, piece: 'Empty', name: 'Empty' };

/** The order the built-in three are reached for, Blue's forms first. */
const BUILTIN_SYMBOLS = 'RPSrps';

interface Palette {
  /** The brushes, in the order they are offered. */
  tools: SetupTool[];
  /** Every symbol a row can hold, as something to draw. */
  bySymbol: Record<string, SetupTool>;
}

/**
 * The palette for a mode, taken from that mode rather than from a list.
 *
 * A published mode carries its own pieces, so a constant here would be a palette
 * that cannot place a single piece of the mode it is open for — and, worse, a
 * board that draws every square already holding one empty, because no constant
 * has ever heard of its symbol.
 *
 * So both halves come from the doors every other board reaches them through:
 * `alphabetOf` for the letters a layout is written with, which is the one place
 * a spec-defined mode and a built-in meet. The standard six letters and no looks
 * at all is the built-in answer, and now the only one.
 *
 * Blue's forms first and then Red's, kinds in the order the mode declares them,
 * matching the Lab's palette: Blue moves first, and a layout is written from
 * rank 1 up, which is the bottom of the picture and Blue's own end of it.
 */
const paletteFor = (mode: ModeDefinition | null | undefined): Palette => {
  const alphabet = alphabetOf(mode);

  const bySymbol: Record<string, SetupTool> = Object.fromEntries(
    Object.entries(alphabet).map(([symbol, { occupant, occupantOwner }]) => [
      symbol,
      {
        symbol,
        color: occupantOwner,
        piece: occupant,
        name: occupant,
      },
    ]),
  );

  const ordered = Array.from(BUILTIN_SYMBOLS);

  // Deduplicated because two kinds sharing a letter would otherwise be two
  // brushes painting the same symbol, only one of which the board can read back.
  const tools: SetupTool[] = [];
  const taken = new Set<string>();
  for (const symbol of ordered) {
    const tool = bySymbol[symbol];
    if (!tool || taken.has(symbol)) continue;
    taken.add(symbol);
    tools.push(tool);
  }

  return { tools: [...tools, ERASER], bySymbol };
};

const normalizeRows = (
  position: StartingPosition | null | undefined,
  shape: BoardShape,
): string[] =>
  Array.from({ length: shape.rows }, (_, y) => {
    const row = position?.rows?.[y];
    return typeof row === 'string' && row.length === shape.columns
      ? row
      : '.'.repeat(shape.columns);
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
  // One editor can serve several modes at once, so the restore buttons are
  // built from the distinct openings behind them rather than one per mode.
  //
  // `mode` leads, because it is the one being edited *for* — a screen that
  // offers a choice passes the whole choice in `modes` as well, and the palette,
  // the board's shape and the opening all have to come from the mode actually
  // selected rather than from whichever happened to be listed first.
  const presetModes = useMemo(() => {
    const rest = (modes ?? []).filter((candidate) => candidate.id !== mode?.id);
    return mode ? [mode, ...rest] : rest;
  }, [mode, modes]);
  const editedMode = presetModes[0] ?? null;
  const palette = useMemo(() => paletteFor(editedMode), [editedMode]);
  // Resolved before the board state, because the shape decides what a row is.
  const defaultPosition = editedMode?.startingPosition ?? null;
  const shape = shapeOf(initialPosition ?? defaultPosition);
  const [rows, setRows] = useState(() => normalizeRows(initialPosition, shape));
  const [selectedSymbol, setSelectedSymbol] = useState(() => palette.tools[0]?.symbol ?? '.');
  const tileSize = Math.max(
    26,
    Math.min(38, Math.floor((width - 68) / Math.max(shape.columns, shape.rows, 1))),
  );
  const presets = useMemo(() => {
    const byLayout = new Map<string, ModeDefinition>();
    presetModes.forEach((candidate) => {
      const layout = candidate.startingPosition.rows.join('/');
      if (!byLayout.has(layout)) byLayout.set(layout, candidate);
    });
    const distinct = Array.from(byLayout.values());
    return distinct.map((candidate) => ({
      id: candidate.id,
      label: distinct.length > 1 ? `${candidate.name.toUpperCase()} SETUP` : 'MODE SETUP',
      position: candidate.startingPosition,
    }));
  }, [presetModes]);

  useEffect(() => {
    if (!visible) return;
    const opened = initialPosition ?? defaultPosition;
    setRows(normalizeRows(opened, shapeOf(opened)));
    // Not a fixed letter: the mode may have changed since this was last open,
    // and a brush the new mode has no piece for paints squares nothing can draw.
    setSelectedSymbol(palette.tools[0]?.symbol ?? '.');
  }, [defaultPosition, initialPosition, palette, visible]);

  const counts = useMemo(() => {
    const symbols: Record<SideColor, string> = { Red: '', Blue: '' };
    for (const tool of palette.tools) if (tool.color) symbols[tool.color] += tool.symbol;
    return {
      Red: countPieces(rows, symbols.Red),
      Blue: countPieces(rows, symbols.Blue),
    };
  }, [palette, rows]);

  if (!editedMode) return null;

  return (
    <ModalCard
      closeLabel="Close position setup"
      eyebrow="CUSTOM POSITION"
      footer={
        <>
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
        </>
      }
      maxWidth={520}
      onClose={onClose}
      subtitle="Choose a piece, then tap squares to place it."
      title={title ?? `${editedMode.name} setup`}
      visible={visible}
    >

          <ScrollView
            contentContainerStyle={styles.scrollContent}
            showsVerticalScrollIndicator={false}
          >
            <View style={styles.palette}>
              {palette.tools.map((tool) => {
                const selected = selectedSymbol === tool.symbol;
                return (
                  <Pressable
                    accessibilityLabel={
                      tool.color ? `Place ${tool.color} ${tool.name}` : 'Erase pieces'
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
                      <PieceIcon color={tool.color} look={tool.look} piece={tool.piece} size={27} />
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
                    const piece = palette.bySymbol[symbol];
                    return (
                      <Pressable
                        accessibilityLabel={`${FILES[x]}${y + 1}${
                          piece ? `, ${piece.color} ${piece.name}` : ', empty'
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
                            look={piece.look}
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
                  onPress={() => setRows(normalizeRows(preset.position, shapeOf(preset.position)))}
                  style={({ pressed }) => [styles.secondaryButton, pressed && styles.pressed]}
                >
                  <Text style={styles.secondaryText}>{preset.label}</Text>
                </Pressable>
              ))}
              <Pressable
                accessibilityRole="button"
                onPress={() => setRows(emptyRows(shape))}
                style={({ pressed }) => [styles.secondaryButton, pressed && styles.pressed]}
              >
                <Text style={styles.secondaryText}>CLEAR BOARD</Text>
              </Pressable>
            </View>
          </ScrollView>

    </ModalCard>
  );
}

const styles = StyleSheet.create({
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
