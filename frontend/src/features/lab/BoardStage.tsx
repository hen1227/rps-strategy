import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Animated, Pressable, StyleSheet, Text, View } from 'react-native';

import Board from '@/features/board/Board';
import PiecePalette from './PiecePalette';
import { spotlightOverlay } from './spotlight';
import { allValidMoves, gridFromRows, validMovesFor } from '@/engine/analysisGame';
import { alphabetFor } from '@/engine/spec/interpret';
import { isStandardPosition } from '@/engine/spec/position';
import { colors, radius, space, type } from '@/theme';
import { GhostButton, PrimaryButton } from '@/ui/primitives';
import { modeBackground, modeLooks } from '@/features/board/modeArt';
import { useLabStore } from '@/store/labSession';
import { callTool } from '@/webmcp/modelContext';
import { MAX_BOARD_SIDE, MAX_BOARD_TILES, MIN_BOARD_SIDE } from '@/types/game';
import type { Position } from '@/types/game';

// The game, while it is being written — and the thing you write it with.
//
// There is always a board here, which is the point of the whole page: a mode you
// cannot look at is a document. When no test game is running it draws the
// *opening position* straight off the draft, so a rule the agent wrote two
// seconds ago is visible before anybody presses anything.
//
// It is also the editor. Rather than a form beside the board that describes the
// board, the board *is* the control: pick a piece and tap a square. That is the
// same reason the palette is built from the mode's own kinds rather than from a
// list of three — a page whose whole claim is that you can invent a game should
// not have an editor that only knows the game it shipped with.
//
// **Every control here goes through `callTool`.** Not `useLabStore`, which is
// what it used to do and which is why a person playing a test move used to leave
// no trace anywhere. Going through the tool means one validation path, one
// transcript, and — the part that matters — the agent finds out. A mode built by
// pressing these buttons and a mode built by an agent are then the same mode,
// made the same way, which is the claim this page exists to make.
//
// Edits are local until they settle. A run of taps placing five pieces is one
// thing somebody meant to do, so it is one `lab_set_starting_position`, not
// five: five would revalidate the spec five times and fill the rail with four
// lines nobody wanted.

/** How long a run of taps has to stop before it counts as finished. */
const SETTLE_MS = 700;

export interface BoardStageProps {
  size: number;
  /** Drives the entrance when the workbench first appears. */
  entrance?: Animated.Value;
}

export default function BoardStage({ size, entrance }: BoardStageProps) {
  const draft = useLabStore((state) => state.draft);
  const report = useLabStore((state) => state.report);
  const mode = useLabStore((state) => state.mode);
  const game = useLabStore((state) => state.game);
  const selected = useLabStore((state) => state.selected);
  const simulation = useLabStore((state) => state.simulation);
  const spotlight = useLabStore((state) => state.spotlight);
  const [showIssues, setShowIssues] = useState(false);

  const [editing, setEditing] = useState(true);
  const [brush, setBrush] = useState<string>('');
  // The rows being painted, before they are committed. `null` means "whatever
  // the draft says" — which is the ordinary state, and is what makes an edit the
  // agent made appear here without this component being told about it.
  const [painted, setPainted] = useState<string[] | null>(null);
  const settle = useRef<ReturnType<typeof setTimeout> | null>(null);

  const playable = report.errors.length === 0;
  const moves = selected && game ? validMovesFor(game, selected) : [];
  const specRows = useMemo(() => draft.startingPosition?.rows ?? [], [draft]);
  const rows = painted ?? specRows;

  // A brush the mode still has. Renaming or removing a kind must not leave the
  // palette painting a letter that means nothing.
  useEffect(() => {
    const symbols = new Set(
      (draft.pieces ?? []).flatMap((piece) => [
        piece.symbol.toUpperCase(),
        piece.symbol.toLowerCase(),
      ]),
    );
    if (!symbols.has(brush) && brush !== '.') {
      setBrush(draft.pieces?.[0]?.symbol.toLowerCase() ?? '.');
    }
  }, [brush, draft.pieces]);

  // A ref beside the state, because the settle timer fires outside React's view
  // of it and would otherwise close over the rows as they were when it was set.
  const paintedRef = useRef<string[] | null>(null);

  /** Send the painted rows, if there are any waiting. */
  const commit = useCallback((next?: string[]) => {
    if (settle.current) {
      clearTimeout(settle.current);
      settle.current = null;
    }
    const send = next ?? paintedRef.current;
    if (!send) return;
    paintedRef.current = null;
    setPainted(null);
    void callTool('lab_set_starting_position', { rows: send }, { origin: 'you' });
  }, []);

  useEffect(() => {
    paintedRef.current = painted;
  }, [painted]);

  // The draft moved under the brush, which means somebody else edited it — the
  // agent, or another agent through `document.modelContext`. Their change is the
  // newer one and the taps were aimed at a board that no longer exists, so the
  // local paint goes rather than being committed over the top of it. This is a
  // no-op in the ordinary case: `commit` clears the paint before the tool call
  // that changes the draft ever runs.
  useEffect(() => {
    paintedRef.current = null;
    setPainted(null);
  }, [specRows]);

  // Nothing half-painted may survive the component. A tab press or a navigation
  // while five pieces are on the board and not in the draft would lose them.
  useEffect(() => () => commit(), [commit]);

  const paint = (position: Position) => {
    const next = rows.map((row, y) =>
      y === position.y
        ? `${row.slice(0, position.x)}${brush}${row.slice(position.x + 1)}`
        : row,
    );
    paintedRef.current = next;
    setPainted(next);
    // The agent's ring is about a board that no longer exists the moment
    // somebody paints on it.
    if (spotlight) useLabStore.getState().setSpotlight(null);
    if (settle.current) clearTimeout(settle.current);
    settle.current = setTimeout(() => commit(), SETTLE_MS);
  };

  const press = (position: Position) => {
    if (editing && !game) {
      paint(position);
      return;
    }
    if (!game) return;
    if (selected && moves.some((move) => move.x === position.x && move.y === position.y)) {
      void callTool(
        'lab_play_move',
        { from: squareName(selected), to: squareName(position) },
        { origin: 'you' },
      );
      return;
    }
    useLabStore.getState().select(position);
  };

  const resize = (axis: 'width' | 'height', by: number) => {
    commit();
    const board = { ...draft.board, [axis]: (draft.board[axis] ?? 0) + by };
    if (board.width < MIN_BOARD_SIDE || board.height < MIN_BOARD_SIDE) return;
    if (board.width > MAX_BOARD_SIDE || board.height > MAX_BOARD_SIDE) return;
    if (board.width * board.height > MAX_BOARD_TILES) return;
    // `lab_patch_spec` carries the opening across a resize on its own — centred
    // on the new width, each side still against its own home rank — so this must
    // not send a layout of its own or it would override that.
    void callTool('lab_patch_spec', { patch: { board } }, { origin: 'you' });
  };

  const opening = (input: Record<string, unknown>) => {
    commit();
    setPainted(null);
    paintedRef.current = null;
    void callTool('lab_set_starting_position', input, { origin: 'you' });
  };

  const startGame = () => {
    commit();
    setEditing(false);
    void callTool('lab_new_test_game', {}, { origin: 'you' });
  };

  // No test game: the opening position, as a picture. Memoised on the rows
  // themselves so a keystroke elsewhere does not rebuild the grid.
  const previewGrid = useMemo(
    () => gridFromRows(rows, alphabetFor(draft)),
    [draft, rows],
  );
  const grid = game?.grid ?? previewGrid;

  // One door for this, shared with every other board in the app — and cached on
  // the spec itself, because every piece is memoised on the object it returns
  // and a fresh one each render re-renders all eighteen of them for nothing.
  const looks = modeLooks({ spec: draft });
  const background = modeBackground({ spec: draft });
  const overlay = useMemo(() => spotlightOverlay(spotlight, grid), [spotlight, grid]);

  const counts = useMemo(() => {
    const tally: Record<string, number> = {};
    for (const row of rows) for (const symbol of row) tally[symbol] = (tally[symbol] ?? 0) + 1;
    return tally;
  }, [rows]);

  // The board's shape, and where it started. The opening is worth a word because
  // it is the one thing on this page you cannot read off the picture: a board
  // massed in front of both home ranks looks the same whether it is the default
  // for this shape or something written by hand a minute ago.
  const shape =
    `${draft.board.width}×${draft.board.height} · ${draft.pieces.length} piece${
      draft.pieces.length === 1 ? '' : 's'
    } · ` + (isStandardPosition(draft) ? 'standard opening' : 'custom opening');

  const style = entrance
    ? {
        opacity: entrance,
        transform: [
          { scale: entrance.interpolate({ inputRange: [0, 1], outputRange: [0.97, 1] }) },
          { translateY: entrance.interpolate({ inputRange: [0, 1], outputRange: [10, 0] }) },
        ],
      }
    : undefined;

  const laying = editing && !game;

  return (
    <Animated.View style={[styles.stage, style]}>
      <View style={styles.heading}>
        <Text style={styles.name} numberOfLines={1}>
          {draft.name}
        </Text>
        <Text style={styles.shape}>{shape}</Text>
      </View>
      <Text style={styles.objective} numberOfLines={2}>
        {draft.objective}
      </Text>

      {/* The palette sits above the board, not beside it: on a phone a column
          beside the board becomes a column below it, and a brush you cannot see
          while you are painting is a brush in the wrong place. */}
      {laying ? (
        <PiecePalette brush={brush} counts={counts} onPick={setBrush} spec={draft} />
      ) : null}

      <View style={[styles.boardFrame, !game && styles.boardIdle]}>
        <Board
          boardSize={size}
          canMove={game !== null && game.status === 'InProgress'}
          grid={grid}
          lastMove={null}
          modeId={mode.id}
          pieceLooks={looks}
          boardBackground={background}
          movableColor={game?.currentTurn ?? null}
          onPieceDrop={(from, to) =>
            void callTool(
              'lab_play_move',
              { from: squareName(from), to: squareName(to) },
              { origin: 'you' },
            )
          }
          onTilePress={press}
          overlay={overlay}
          playerColor="Red"
          selectedTile={selected}
          validMoves={moves}
        />
      </View>

      {spotlight?.note ? <Text style={styles.pointing}>{spotlight.note}</Text> : null}

      {laying ? (
        <View style={styles.laying}>
          <Stepper
            label="WIDE"
            onChange={(by) => resize('width', by)}
            value={draft.board.width}
          />
          <Stepper
            label="TALL"
            onChange={(by) => resize('height', by)}
            value={draft.board.height}
          />
          <GhostButton label="STANDARD" onPress={() => opening({ preset: 'standard' })} />
          <GhostButton label="CLEAR" onPress={() => opening({ preset: 'empty' })} />
          <GhostButton
            label="MIRROR"
            onPress={() =>
              opening({ rows: rows.slice(0, Math.ceil(rows.length / 2)), mirror: true })
            }
          />
        </View>
      ) : null}

      <View style={styles.controls}>
        <PrimaryButton
          label={game ? 'RESTART' : 'PLAY IT'}
          disabled={!playable}
          onPress={startGame}
        />
        {game ? (
          <>
            <GhostButton
              label="UNDO"
              onPress={() => void callTool('lab_undo', {}, { origin: 'you' })}
            />
            <GhostButton
              label="EDIT"
              onPress={() => {
                setEditing(true);
                void callTool('lab_end_test_game', {}, { origin: 'you' });
              }}
            />
          </>
        ) : null}
        <GhostButton
          label="PLAYTEST"
          onPress={() => {
            commit();
            void callTool('lab_simulate', { games: 40, strength: 0.6 }, { origin: 'you' });
          }}
        />
      </View>

      <View style={styles.strip}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={playable ? 'The rules are playable' : 'Show what is wrong'}
          disabled={playable && report.warnings.length === 0}
          onPress={() => setShowIssues((was) => !was)}
          style={styles.cell}
        >
          <Text style={[styles.cellValue, !playable && styles.bad, playable && styles.good]}>
            {playable
              ? report.warnings.length === 0
                ? '✓ Playable'
                : `Playable · ${report.warnings.length} to look at`
              : `${report.errors.length} problem${report.errors.length === 1 ? '' : 's'}`}
          </Text>
          <Text style={styles.cellLabel}>RULES</Text>
        </Pressable>

        {simulation ? (
          <View style={styles.cell}>
            <Text style={styles.cellValue} numberOfLines={1}>
              Red {simulation.redWins} · Blue {simulation.blueWins} · drawn {simulation.draws}
            </Text>
            <Text style={styles.cellLabel}>{simulation.games} TEST GAMES</Text>
          </View>
        ) : null}

        {game ? (
          <View style={styles.cell}>
            <Text style={styles.cellValue} numberOfLines={1}>
              {game.status === 'InProgress'
                ? `${game.currentTurn} to move · ${allValidMoves(game).length} moves`
                : `${game.winner === 'Neutral' ? 'Drawn' : `${game.winner} wins`} by ${game.endReason}`}
            </Text>
            <Text style={styles.cellLabel}>MOVE {game.moveNumber}</Text>
          </View>
        ) : null}
      </View>

      {showIssues ? (
        <View style={styles.issues}>
          {report.errors.map((issue) => (
            <Text key={`e-${issue.path}${issue.message}`} style={styles.issueError}>
              {issue.path || '(spec)'} — {issue.message}
            </Text>
          ))}
          {report.warnings.map((issue) => (
            <Text key={`w-${issue.path}${issue.message}`} style={styles.issueWarning}>
              {issue.path || '(spec)'} — {issue.message}
            </Text>
          ))}
        </View>
      ) : null}

      {simulation && simulation.notes.length > 0 ? (
        <View style={styles.notes}>
          {simulation.notes.slice(0, 3).map((note) => (
            <Text key={note} style={styles.note}>
              • {note}
            </Text>
          ))}
        </View>
      ) : null}
    </Animated.View>
  );
}

const FILES = 'abcdefghijklmnopqrstuvwxyz';

/** The name a tool takes a square by, which is what these buttons speak. */
const squareName = ({ x, y }: Position) => `${FILES[x] ?? '?'}${y + 1}`;

function Stepper({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (by: number) => void;
}) {
  return (
    <View style={styles.stepper}>
      <Pressable
        accessibilityLabel={`One fewer ${label.toLowerCase()}`}
        accessibilityRole="button"
        onPress={() => onChange(-1)}
        style={styles.step}
      >
        <Text style={styles.stepText}>−</Text>
      </Pressable>
      <View style={styles.stepValue}>
        <Text style={styles.cellValue}>{value}</Text>
        <Text style={styles.cellLabel}>{label}</Text>
      </View>
      <Pressable
        accessibilityLabel={`One more ${label.toLowerCase()}`}
        accessibilityRole="button"
        onPress={() => onChange(1)}
        style={styles.step}
      >
        <Text style={styles.stepText}>+</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  stage: { alignItems: 'center', gap: space.small, padding: space.medium },
  heading: {
    alignItems: 'baseline',
    flexDirection: 'row',
    gap: space.small,
    maxWidth: '100%',
  },
  name: { ...type.sectionTitle, color: colors.textStrong, flexShrink: 1, minWidth: 0 },
  shape: { ...type.meta, color: colors.textFaint },
  objective: { ...type.meta, color: colors.textDim, textAlign: 'center', maxWidth: 520 },
  boardFrame: { borderRadius: radius.medium, marginTop: space.snug },
  // A board nobody is playing yet is a picture of one, and says so quietly.
  boardIdle: { opacity: 0.92 },
  pointing: { ...type.meta, color: colors.accentText, textAlign: 'center', maxWidth: 520 },
  laying: {
    alignItems: 'center',
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: space.snug,
    justifyContent: 'center',
    marginTop: space.snug,
  },
  stepper: {
    alignItems: 'center',
    borderColor: colors.borderSoft,
    borderRadius: radius.small,
    borderWidth: 1,
    flexDirection: 'row',
  },
  step: { paddingHorizontal: space.snug, paddingVertical: space.tight },
  stepText: { color: colors.textMuted, fontSize: 15, lineHeight: 18 },
  stepValue: { alignItems: 'center', minWidth: 30 },
  controls: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: space.small,
    justifyContent: 'center',
    marginTop: space.snug,
  },
  strip: {
    alignItems: 'stretch',
    alignSelf: 'stretch',
    borderTopColor: colors.borderSoft,
    borderTopWidth: 1,
    flexDirection: 'row',
    flexWrap: 'wrap',
    marginTop: space.small,
    paddingTop: space.small,
  },
  cell: { flex: 1, gap: 2, minWidth: 120, paddingHorizontal: space.snug },
  cellValue: { ...type.meta, color: colors.textSoft },
  cellLabel: { ...type.eyebrow, color: colors.textFaint },
  good: { color: colors.accentText },
  bad: { color: colors.dangerSoft },
  issues: { alignSelf: 'stretch', gap: 2, marginTop: space.snug },
  issueError: { ...type.meta, color: colors.dangerSoft },
  issueWarning: { ...type.meta, color: colors.textMuted },
  notes: { alignSelf: 'stretch', gap: 2, marginTop: space.snug },
  note: { ...type.meta, color: colors.textDim },
});
