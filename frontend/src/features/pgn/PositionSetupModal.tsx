import * as Clipboard from 'expo-clipboard';
import { useEffect, useMemo, useState } from 'react';
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from 'react-native';

import {
  alphabetOf,
  gridFromRows,
  ownerRowsFrom,
  sideToMove,
  type StartingBoard,
} from '@/engine/analysisGame';
import { decodePosition, encodePosition, startingRowsFrom } from '@/engine/pgn';
import { failureMessage } from '@/errors';
import type { PieceLook } from '@/features/board/pieceLook';
import PieceIcon from '@/features/board/PieceIcon';
import { board, colors, players, radius, themedSheet } from '@/theme';
import ModalCard from '@/ui/ModalCard';
import {
  BOARD_SIZE,
  FIRST_TO_MOVE,
  isBoardRows,
  modeHasFeature,
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

/** The territory brushes: an owner, or nobody. Blue first, as the pieces are. */
const OWNER_TOOLS: { letter: string; color: SideColor | null; label: string }[] = [
  { letter: 'b', color: 'Blue', label: 'BLUE' },
  { letter: 'r', color: 'Red', label: 'RED' },
  { letter: '.', color: null, label: 'NONE' },
];

const ownerLetterFor = (color: SideColor | null | undefined) =>
  color === 'Red' ? 'r' : color === 'Blue' ? 'b' : '.';

/** Territory as it stands with nobody having said otherwise: under the pieces. */
const ownersFollowingPieces = (rows: string[], palette: Palette): string[] =>
  rows.map((row) =>
    Array.from(row, (symbol) => ownerLetterFor(palette.bySymbol[symbol]?.color)).join(''),
  );

/** A position's whitespace-separated fields: pieces, side to move, territory. */
const fenFields = (text: string) => text.trim().split(/\s+/).filter(Boolean);

/** What the editor hands back, in both the forms its two callers need. */
export interface SetUpBoard {
  /**
   * Pieces and nothing else — the form a posted challenge can carry, because
   * `GameSetup.StartingPosition` is a layout string and two setups are paired
   * by comparing them.
   */
  position: StartingPosition;
  /** Pieces, side to move and territory — the form a game can begin from. */
  board: StartingBoard;
}

export interface PositionSetupModalProps {
  /**
   * How much of a board this editor may describe.
   *
   * `pieces` is where each piece stands, which is all a posted challenge can
   * agree to. `position` adds the side to move and, in a mode that has
   * territory, who owns each tile — the two things the three-field FEN carries
   * and rows cannot. A board somebody is about to *play* needs both: "Red to
   * play" is half of what makes a position a question rather than a picture.
   */
  describes?: 'pieces' | 'position';
  /** Territory to open with. Absent follows the pieces. `position` only. */
  initialOwners?: string[] | null;
  /** The board to open with. Falls back to the mode's own opening. */
  initialPosition?: StartingPosition | null;
  /** The side to move to open with. `position` only. */
  initialTurn?: SideColor;
  /** The one mode being edited for, when there is only one. */
  mode?: ModeDefinition | null;
  /** Several modes, when one editor serves a screen that offers a choice. */
  modes?: ModeDefinition[] | null;
  onApply: (setUp: SetUpBoard) => void;
  onClose: () => void;
  title?: string;
  visible: boolean;
}

export default function PositionSetupModal({
  describes = 'pieces',
  initialOwners,
  initialPosition,
  initialTurn = FIRST_TO_MOVE,
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
  const [currentTurn, setCurrentTurn] = useState<SideColor>(initialTurn);
  // `null` is "territory follows the pieces", which is every board until
  // somebody paints one. Held as an absence rather than as a copy so that
  // placing a piece goes on claiming its tile right up until a caller says
  // otherwise, and so "follow the pieces again" is a value rather than a redraw.
  const [owners, setOwners] = useState<string[] | null>(() =>
    initialOwners ? normalizeRows({ rows: initialOwners }, shape) : null,
  );
  const [layer, setLayer] = useState<'pieces' | 'territory'>('pieces');
  const [selectedOwner, setSelectedOwner] = useState('b');
  // The text box's contents while somebody is typing in it, and `null` the rest
  // of the time, meaning "whatever the board currently says". Held as an absence
  // for the same reason `owners` is: a half-typed position is not a board, and
  // rewriting the field under the cursor on every keystroke is how a text box
  // that mirrors something else becomes impossible to type into.
  const [fenDraft, setFenDraft] = useState<string | null>(null);
  // Why a pasted position was refused, or what was dropped from one that was
  // taken. `bad` is the difference between the two, which is the difference
  // between a board that did not change and one that did.
  const [fenIssue, setFenIssue] = useState<{ text: string; bad: boolean } | null>(null);
  // What was copied, rather than that something was — see `BoardExportModal`,
  // which holds the same pair for the same reason: the label has to fall back
  // to COPY once the board has moved on from what is on the clipboard.
  const [copied, setCopied] = useState<{ text: string; ok: boolean } | null>(null);
  const wholeBoard = describes === 'position';
  // Territory is drawn only where it can be *meant*: a mode without the feature
  // owns nothing, and a challenge cannot carry ownership even in a mode that has
  // it, so offering the layer there would be an edit the other player never sees.
  const showTerritory = wholeBoard && modeHasFeature(editedMode, 'territory');
  const activeLayer = showTerritory ? layer : 'pieces';
  // Rank 1 is drawn at the bottom, the way `Board` and `MiniBoard` draw it, so
  // the rows are reversed on the way to the screen and each keeps the rank it
  // is. A layout is written from rank 1 up; a board is looked at from Blue's
  // end down. Drawing the array in its own order made those the same thing,
  // which put Blue's army along the top and labelled the top left square a1 —
  // and a position drawn here then played out mirrored end for end.
  const drawnRows = useMemo(
    () => rows.map((row, y) => ({ row, y })).reverse(),
    [rows],
  );
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
    setCurrentTurn(initialTurn);
    setOwners(initialOwners ? normalizeRows({ rows: initialOwners }, shapeOf(opened)) : null);
    setLayer('pieces');
    setSelectedOwner('b');
    setFenDraft(null);
    setFenIssue(null);
    setCopied(null);
  }, [defaultPosition, initialOwners, initialPosition, initialTurn, palette, visible]);

  const effectiveOwners = useMemo(
    () => owners ?? ownersFollowingPieces(rows, palette),
    [owners, palette, rows],
  );

  const counts = useMemo(() => {
    const symbols: Record<SideColor, string> = { Red: '', Blue: '' };
    for (const tool of palette.tools) if (tool.color) symbols[tool.color] += tool.symbol;
    return {
      Red: countPieces(rows, symbols.Red),
      Blue: countPieces(rows, symbols.Blue),
    };
  }, [palette, rows]);

  // The board as one line of text, which is the form it travels in everywhere
  // else in the app: `encodePosition` is what COPY POSITION writes and what the
  // archive stores, so a position lifted off any other screen pastes in here
  // and a position built here pastes back out. Written through the same door
  // rather than assembled from `rows`, so the two cannot drift apart.
  const fen = useMemo(
    () =>
      encodePosition(
        gridFromRows(rows, alphabetOf(editedMode), showTerritory ? effectiveOwners : undefined),
        wholeBoard ? currentTurn : FIRST_TO_MOVE,
        { territory: showTerritory },
      ),
    [currentTurn, editedMode, effectiveOwners, rows, showTerritory, wholeBoard],
  );
  const fenText = fenDraft ?? fen;
  const copiedState = copied?.text === fenText ? copied : null;

  // Every edit made on the board itself hands the text box back to the board.
  // Without this, painting a square under a draft would leave the field showing
  // a position that is no longer the one drawn above it.
  const releaseFenDraft = () => {
    setFenDraft(null);
    setFenIssue(null);
  };

  /**
   * Read a typed or pasted position onto the board.
   *
   * The text is kept exactly as entered whatever happens to it — a position
   * refused for being the wrong shape is one somebody is still fixing, and a
   * position taken is not always written back the way it was typed, since
   * `encodePosition` has its own spelling for a run of empty squares.
   */
  const readFen = (value: string) => {
    setFenDraft(value);
    if (!value.trim()) {
      setFenIssue(null);
      return;
    }
    let read;
    try {
      read = decodePosition(value);
    } catch (error) {
      setFenIssue({ bad: true, text: failureMessage(error, 'This is not a position.') });
      return;
    }
    // A custom position has to be the board the mode is played on — see
    // `GameSetup.ValidateFor` — and `normalizeRows` would quietly swap a
    // mismatched rank for an empty one, which is a board nobody asked for.
    const columns = read.grid[0]?.length ?? 0;
    if (columns !== shape.columns || read.grid.length !== shape.rows) {
      setFenIssue({
        bad: true,
        text: `That is a ${columns}×${read.grid.length} board. ${editedMode?.name ?? 'This mode'} is played on ${shape.columns}×${shape.rows}.`,
      });
      return;
    }
    setRows(startingRowsFrom(read.grid));
    // No third field is "territory follows the pieces", which is the absence
    // the rest of this editor already speaks in.
    if (showTerritory) {
      setOwners(fenFields(value).length > 2 ? ownerRowsFrom(read.grid) : null);
    }
    if (wholeBoard) setCurrentTurn(sideToMove(read.currentTurn));
    // What the editor cannot carry is said out loud rather than dropped in
    // silence: a position pasted from a game is a whole board, and this editor
    // is sometimes only allowed to describe the pieces on one.
    const dropped = [
      !wholeBoard && read.currentTurn !== 'Neutral' && read.currentTurn !== FIRST_TO_MOVE
        ? 'the side to move'
        : null,
      !showTerritory && modeHasFeature(editedMode, 'territory') && fenFields(value).length > 2
        ? 'the territory'
        : null,
    ].filter(Boolean);
    setFenIssue(
      dropped.length
        ? {
            bad: false,
            text: `Pieces placed. This setup carries pieces only, so ${dropped.join(
              ' and ',
            )} ${dropped.length > 1 ? 'were' : 'was'} dropped.`,
          }
        : null,
    );
  };

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
            onPress={() =>
              onApply({
                position: { rows },
                board: {
                  // A board that may not state a turn opens with the first
                  // mover, which is what a game started from rows does anyway.
                  currentTurn: wholeBoard ? currentTurn : FIRST_TO_MOVE,
                  // Undefined territory is not "no territory": it tells
                  // `gridFromRows` to let ownership follow the pieces.
                  grid: gridFromRows(
                    rows,
                    alphabetOf(editedMode),
                    showTerritory ? effectiveOwners : undefined,
                  ),
                },
              })
            }
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
            {showTerritory && (
              <View style={styles.layerRow}>
                {(['pieces', 'territory'] as const).map((option) => {
                  const selected = activeLayer === option;
                  return (
                    <Pressable
                      accessibilityRole="radio"
                      accessibilityState={{ checked: selected }}
                      key={option}
                      onPress={() => setLayer(option)}
                      style={({ pressed }) => [
                        styles.layerTab,
                        selected && styles.layerTabSelected,
                        pressed && styles.pressed,
                      ]}
                    >
                      <Text style={[styles.layerText, selected && styles.layerTextSelected]}>
                        {option.toUpperCase()}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
            )}

            <View style={styles.palette}>
              {activeLayer === 'territory'
                ? OWNER_TOOLS.map((tool) => {
                    const selected = selectedOwner === tool.letter;
                    return (
                      <Pressable
                        accessibilityLabel={
                          tool.color ? `Give the tile to ${tool.color}` : 'Leave the tile unowned'
                        }
                        accessibilityRole="radio"
                        accessibilityState={{ checked: selected }}
                        key={tool.letter}
                        onPress={() => setSelectedOwner(tool.letter)}
                        style={({ pressed }) => [
                          styles.tool,
                          selected && styles.toolSelected,
                          pressed && styles.pressed,
                        ]}
                      >
                        <View
                          style={[
                            styles.ownerSwatch,
                            tool.color
                              ? { backgroundColor: players[tool.color].territory }
                              : styles.ownerSwatchNone,
                          ]}
                        />
                        <Text style={[styles.toolLabel, selected && styles.toolLabelSelected]}>
                          {tool.label}
                        </Text>
                      </Pressable>
                    );
                  })
                : palette.tools.map((tool) => {
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
                          <PieceIcon
                            color={tool.color}
                            look={tool.look}
                            piece={tool.piece}
                            size={27}
                          />
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
              {drawnRows.map(({ row, y }) => (
                <View key={`row-${y}`} style={styles.boardRow}>
                  {Array.from(row, (symbol, x) => {
                    const piece = palette.bySymbol[symbol];
                    const owner = showTerritory ? effectiveOwners[y]?.[x] : undefined;
                    const ownerName = owner === 'r' ? 'Red' : owner === 'b' ? 'Blue' : null;
                    return (
                      <Pressable
                        accessibilityLabel={`${FILES[x]}${y + 1}${
                          piece ? `, ${piece.color} ${piece.name}` : ', empty'
                        }${ownerName ? `, ${ownerName}'s ground` : ''}`}
                        accessibilityRole="button"
                        key={`${x}:${y}`}
                        onPress={() => {
                          releaseFenDraft();
                          if (activeLayer === 'territory') {
                            setOwners((current) =>
                              replaceSymbol(current ?? effectiveOwners, x, y, selectedOwner),
                            );
                          } else {
                            setRows((current) => replaceSymbol(current, x, y, selectedSymbol));
                          }
                        }}
                        style={({ pressed }) => [
                          styles.tile,
                          { width: tileSize, height: tileSize },
                          (x + y) % 2 === 0 ? styles.tileLight : styles.tileDark,
                          ownerName === 'Red' && styles.tileGroundRed,
                          ownerName === 'Blue' && styles.tileGroundBlue,
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
              {!wholeBoard && <Text style={styles.turnLabel}>BLUE MOVES FIRST</Text>}
              <Text style={[styles.summary, styles.blueSummary]}>BLUE · {counts.Blue}</Text>
            </View>

            {wholeBoard && (
              <View style={styles.turnRow}>
                <Text style={styles.turnLabel}>TO PLAY</Text>
                {(['Blue', 'Red'] as const).map((side) => {
                  const selected = currentTurn === side;
                  return (
                    <Pressable
                      accessibilityLabel={`${side} to play`}
                      accessibilityRole="radio"
                      accessibilityState={{ checked: selected }}
                      key={side}
                      onPress={() => {
                        releaseFenDraft();
                        setCurrentTurn(side);
                      }}
                      style={({ pressed }) => [
                        styles.turnChip,
                        selected && { borderColor: players[side].strong },
                        pressed && styles.pressed,
                      ]}
                    >
                      <Text
                        style={[
                          styles.turnChipText,
                          selected && { color: players[side].strong },
                        ]}
                      >
                        {side.toUpperCase()}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
            )}

            <View style={styles.quickActions}>
              {presets.map((preset) => (
                <Pressable
                  accessibilityRole="button"
                  key={preset.id}
                  onPress={() => {
                    releaseFenDraft();
                    setRows(normalizeRows(preset.position, shapeOf(preset.position)));
                  }}
                  style={({ pressed }) => [styles.secondaryButton, pressed && styles.pressed]}
                >
                  <Text style={styles.secondaryText}>{preset.label}</Text>
                </Pressable>
              ))}
              <Pressable
                accessibilityRole="button"
                onPress={() => {
                  releaseFenDraft();
                  setRows(emptyRows(shape));
                  setOwners(null);
                }}
                style={({ pressed }) => [styles.secondaryButton, pressed && styles.pressed]}
              >
                <Text style={styles.secondaryText}>CLEAR BOARD</Text>
              </Pressable>
              {activeLayer === 'territory' && owners !== null && (
                <Pressable
                  accessibilityRole="button"
                  onPress={() => {
                    releaseFenDraft();
                    setOwners(null);
                  }}
                  style={({ pressed }) => [styles.secondaryButton, pressed && styles.pressed]}
                >
                  <Text style={styles.secondaryText}>FOLLOW PIECES</Text>
                </Pressable>
              )}
            </View>

            {/*
              The board in the one form it can leave the app in. Editable rather
              than shown, because the two halves of moving a position around are
              copying one and pasting one, and a field that only ever displays
              is half a feature.
            */}
            <View style={styles.fenBlock}>
              <View style={styles.fenRow}>
                <Text style={styles.turnLabel}>FEN</Text>
                <TextInput
                  accessibilityLabel="Position as text"
                  autoCapitalize="none"
                  autoComplete="off"
                  autoCorrect={false}
                  onChangeText={readFen}
                  placeholder={emptyRows(shape).join('/')}
                  placeholderTextColor={colors.textFaint}
                  spellCheck={false}
                  style={styles.fenInput}
                  value={fenText}
                />
                <Pressable
                  accessibilityLabel="Copy this position as text"
                  accessibilityRole="button"
                  onPress={async () => {
                    try {
                      setCopied({ text: fenText, ok: await Clipboard.setStringAsync(fenText) });
                    } catch {
                      // `setStringAsync` resolves `false` on the web rather than
                      // throwing when the browser refuses the clipboard, so both
                      // ways of failing have to land on the same label.
                      setCopied({ text: fenText, ok: false });
                    }
                  }}
                  style={({ pressed }) => [styles.fenCopy, pressed && styles.pressed]}
                >
                  <Text style={styles.secondaryText}>
                    {copiedState ? (copiedState.ok ? 'COPIED ✓' : 'NO CLIPBOARD') : 'COPY'}
                  </Text>
                </Pressable>
              </View>
              {fenIssue ? (
                <Text
                  accessibilityLiveRegion="polite"
                  style={[styles.fenMessage, fenIssue.bad && styles.fenMessageBad]}
                >
                  {fenIssue.text}
                </Text>
              ) : null}
            </View>
          </ScrollView>

    </ModalCard>
  );
}

const styles = themedSheet(() => ({
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
  layerRow: { flexDirection: 'row', gap: 6, marginBottom: 9 },
  layerTab: {
    minHeight: 26,
    justifyContent: 'center',
    paddingHorizontal: 11,
    borderRadius: radius.small,
    borderWidth: 1,
    borderColor: colors.borderStrong,
  },
  layerTabSelected: { borderColor: colors.accent, backgroundColor: colors.accentSurfaceStrong },
  layerText: { color: colors.textFaint, fontSize: 7, fontWeight: '900' },
  layerTextSelected: { color: colors.accentSoft },
  ownerSwatch: { width: 21, height: 21, borderRadius: radius.small },
  ownerSwatchNone: { borderWidth: 1, borderColor: colors.borderStrong },
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
  tileGroundRed: { backgroundColor: players.Red.territory },
  tileGroundBlue: { backgroundColor: players.Blue.territory },
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
  turnRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 9 },
  turnChip: {
    minHeight: 26,
    justifyContent: 'center',
    paddingHorizontal: 13,
    borderRadius: radius.small,
    borderWidth: 1,
    borderColor: colors.borderStrong,
  },
  turnChipText: { color: colors.textFaint, fontSize: 8, fontWeight: '900' },
  quickActions: { flexDirection: 'row', gap: 8, marginTop: 13 },
  // The one row here that is not measured against the board: a nine-rank
  // position is a few characters wider than nine tiles are, and a field capped
  // at the board's width cut the side to move off the end of its own text.
  fenBlock: { alignSelf: 'stretch', marginTop: 13 },
  fenRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  fenInput: {
    // `minWidth` because a flexed child takes its content's width as its floor,
    // and a position is one long unbreakable token: without it the field pushes
    // the copy button off the end of the row instead of scrolling.
    flex: 1,
    minWidth: 0,
    minHeight: 32,
    paddingHorizontal: 8,
    paddingVertical: 6,
    borderRadius: radius.small,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    backgroundColor: colors.surfaceSunken,
    color: colors.text,
    fontFamily: 'monospace',
    fontSize: 10,
  },
  fenCopy: {
    minHeight: 32,
    justifyContent: 'center',
    paddingHorizontal: 9,
    borderRadius: radius.small,
    borderWidth: 1,
    borderColor: colors.borderStrong,
  },
  fenMessage: { color: colors.textFaint, fontSize: 8, lineHeight: 12, marginTop: 5 },
  fenMessageBad: { color: colors.dangerText },
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
}));
