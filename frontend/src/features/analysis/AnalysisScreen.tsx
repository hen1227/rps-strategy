import { useRouter } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import EngineLinesCard from './EngineLinesCard';
import EvalBar from './EvalBar';
import MoveQualityBadge from './MoveQualityBadge';
import TerritoryMeter from './TerritoryMeter';
import {
  applyAnalysisMove,
  createAnalysisGame,
  moveLabel,
  startingPositionFromGrid,
  type AnalysisGame,
} from '@/engine/analysisGame';
import { reviewSourceFromPGN, type GradedMove, type ReviewMove } from '@/engine/gameReview';
import { ANALYSIS_PRESETS, type AnalysisPresetName } from '@/engine/rpsfish/client';
import type { Analysis } from '@/engine/rpsfish/protocol';
import Board from '@/features/board/Board';
import { usePieceDrag } from '@/features/board/pieceDrag';
import PGNImportModal from '@/features/pgn/PGNImportModal';
import PositionSetupModal from '@/features/pgn/PositionSetupModal';
import { useBoardLayout } from '@/hooks/useBoardLayout';
import { useBoardSelection } from '@/hooks/useBoardSelection';
import { useReach } from '@/hooks/useReach';
import ReachPanel from '@/features/reach/ReachPanel';
import useGameAnalysis from '@/hooks/useGameAnalysis';
import { usePositionAnalysis, type SearchStatus } from '@/hooks/usePositionAnalysis';
import useReplayKeyboard from '@/hooks/useReplayKeyboard';
import { links } from '@/navigation/links';
import { useSettledSearchParams } from '@/navigation/useSettledSearchParams';
import { useGameStore } from '@/store/gameStore';
import { useReviewHandoff } from '@/store/reviewHandoff';
import { colors, players, radius } from '@/theme';
import type {
  ModeDefinition,
  Move,
  Position,
  SideColor,
  StartingPosition,
} from '@/types/game';

/** How hard the interactive search is allowed to think. */
type AnalysisSearchMode = AnalysisPresetName;

/**
 * A move played on this board.
 *
 * The least the review walk needs. A record's moves carry clocks and captured
 * pieces as well; a board somebody is playing on has neither, and the walk
 * grades both the same way — see `GradableMove`.
 */
interface BoardPlay extends Move {
  player: SideColor;
}

// The board's own search budget and the budget its grades are measured at are
// two different things: one is redone every time the position changes and only
// has to keep up with a person clicking, the other has to be worth writing a
// grade down from. They move together so that "GO DEEP" deepens both.
const GRADE_PRESETS: Record<AnalysisSearchMode, string> = { standard: 'standard', deep: 'deep' };

/** The two budgets the board offers, weakest first. */
const SEARCH_MODES: AnalysisSearchMode[] = ['standard', 'deep'];

const confidenceLabel = (confidence: number) => {
  if (confidence >= 80) return 'HIGH';
  if (confidence >= 50) return 'MEDIUM';
  return 'LOW';
};

// A move can give up nothing without being the move the engine named, so
// "best was X" is only said when playing X would actually have been better.
const lastMoveVerdict = (entry: ReviewMove<BoardPlay>) => {
  if (entry.pending) return 'RPSFish is grading this move…';
  const best = entry.bestMove ? moveLabel(entry.bestMove) : 'not available';
  if (entry.grade.key === 'great') {
    return 'The only move that stayed within the Good threshold.';
  }
  if (entry.isTopMove) return `The engine's own choice at depth ${entry.depth}.`;
  if (entry.lossPercent < 0.05) return `As strong as ${best}.`;
  return `Best was ${best} · ${entry.lossPercent.toFixed(1)} points of expected score lost`;
};

interface AnalysisPanelProps {
  analysis: Analysis | null;
  analysisMode: AnalysisSearchMode;
  canMakeBestMove: boolean;
  engineState: SearchStatus;
  game: AnalysisGame;
  gradeError: string | null;
  gradedMoves: ReviewMove<BoardPlay>[];
  onAnalysisModeChange: (mode: AnalysisSearchMode) => void;
  onMakeBestMove: () => void;
  onSetPosition: () => void;
  /** Absent in a mode with no goal row for the reach tool to measure against. */
  onToggleReach?: () => void;
  reachShowing?: boolean;
}

function AnalysisPanel({
  analysis,
  analysisMode,
  canMakeBestMove,
  engineState,
  game,
  gradeError,
  gradedMoves,
  onAnalysisModeChange,
  onMakeBestMove,
  onSetPosition,
  onToggleReach,
  reachShowing = false,
}: AnalysisPanelProps) {
  const lastMove = gradedMoves[gradedMoves.length - 1];
  const activeColor = game.currentTurn;

  return (
    <View style={styles.panelStack}>
      <View style={styles.coachCard}>
        <View style={styles.cardHeader}>
          <View>
            <Text style={styles.cardEyebrow}>RPSFISH COACH</Text>
            <Text style={styles.cardTitle}>
              {game.status === 'Finished'
                ? game.winner === 'Neutral'
                  ? 'Analysis complete · draw'
                  : `${game.winner} wins`
                : `${activeColor} to move`}
            </Text>
          </View>
          {engineState === 'thinking' && <ActivityIndicator color={colors.accent} size="small" />}
        </View>
        <Text style={styles.cardBody}>
          {engineState === 'thinking'
            ? analysis
              ? `Searching deeper from depth ${analysis.depth}. The top three moves update after each completed iteration.`
              : analysisMode === 'deep'
                ? 'Starting a long, three-line search with strict time and node safety caps…'
                : 'Calculating the three strongest continuations…'
            : game.status === 'Finished'
              ? 'Review the move grades below or reset the board for another line.'
              : 'The arrows match the ranked engine lines below. You control both sides.'}
        </Text>
        <View style={styles.analysisModeRow}>
          <Text style={styles.analysisModeLabel}>SEARCH</Text>
          {SEARCH_MODES.map((searchMode) => (
            <Pressable
              accessibilityLabel={`Use ${searchMode} RPSFish analysis`}
              accessibilityRole="button"
              accessibilityState={{ selected: analysisMode === searchMode }}
              key={searchMode}
              onPress={() => onAnalysisModeChange(searchMode)}
              style={({ pressed }) => [
                styles.analysisModeButton,
                analysisMode === searchMode && styles.analysisModeButtonActive,
                pressed && styles.buttonPressed,
              ]}
            >
              <Text
                style={[
                  styles.analysisModeButtonText,
                  analysisMode === searchMode && styles.analysisModeButtonTextActive,
                ]}
              >
                {searchMode === 'deep' ? 'GO DEEP' : 'STANDARD'}
              </Text>
            </Pressable>
          ))}
          <Pressable
            accessibilityLabel="Set up a custom analysis position"
            accessibilityRole="button"
            onPress={onSetPosition}
            style={({ pressed }) => [
              styles.setPositionButton,
              pressed && styles.buttonPressed,
            ]}
          >
            <Text style={styles.setPositionButtonText}>SET POSITION</Text>
          </Pressable>
          {onToggleReach && (
            <Pressable
              accessibilityHint="Shows how far every piece is from every square, and which runs to the goal cannot be cut off."
              accessibilityLabel={reachShowing ? 'Hide the reach maps' : 'Show the reach maps'}
              accessibilityRole="switch"
              accessibilityState={{ checked: reachShowing }}
              onPress={onToggleReach}
              style={({ pressed }) => [
                styles.analysisModeButton,
                reachShowing && styles.analysisModeButtonActive,
                pressed && styles.buttonPressed,
              ]}
            >
              <Text
                style={[
                  styles.analysisModeButtonText,
                  reachShowing && styles.analysisModeButtonTextActive,
                ]}
              >
                REACH
              </Text>
            </Pressable>
          )}
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ disabled: !canMakeBestMove }}
          disabled={!canMakeBestMove}
          onPress={onMakeBestMove}
          style={({ pressed }) => [
            styles.bestMoveButton,
            !canMakeBestMove && styles.bestMoveButtonDisabled,
            pressed && canMakeBestMove && styles.buttonPressed,
          ]}
        >
          <View style={styles.bestMoveButtonCopy}>
            <Text style={styles.bestMoveButtonText}>Make Best Move</Text>
            <Text style={styles.bestMoveButtonDetail}>
              {analysis?.lines[0]
                ? `${moveLabel(analysis.lines[0])} · depth ${analysis.depth}`
                : engineState === 'thinking'
                  ? 'Waiting for RPSFish…'
                  : 'No move available'}
            </Text>
          </View>
          <Text style={styles.bestMoveButtonArrow}>→</Text>
        </Pressable>
      </View>

      {game.mode.features?.includes('territory') && <TerritoryMeter grid={game.grid} />}

      {lastMove && (
        <View style={styles.lastMoveCard}>
          <View style={styles.lastMoveTop}>
            <View>
              <Text style={styles.cardEyebrow}>LAST MOVE</Text>
              <Text style={styles.lastMoveNotation}>
                {lastMove.index + 1}. {moveLabel(lastMove)}
              </Text>
            </View>
            {lastMove.pending ? (
              <ActivityIndicator color={colors.textMuted} size="small" />
            ) : (
              <MoveQualityBadge grade={lastMove.grade} />
            )}
          </View>
          <Text style={styles.bestMoveCopy}>{lastMoveVerdict(lastMove)}</Text>
        </View>
      )}

      <EngineLinesCard
        analysis={analysis}
        emptyMessage={
          engineState === 'error' ? 'Engine analysis unavailable.' : 'No legal continuation.'
        }
        meta={
          analysis
            ? `${analysisMode.toUpperCase()} · DEPTH ${analysis.depth}/${analysis.selectiveDepth} · ${analysis.nodes.toLocaleString()} NODES · ${confidenceLabel(analysis.confidence)} CONFIDENCE`
            : null
        }
        turn={activeColor}
      />

      <View style={styles.historyCard}>
        <Text style={styles.cardEyebrow}>MOVE QUALITY</Text>
        {gradeError ? <Text style={styles.historyEmpty}>{gradeError}</Text> : null}
        {gradedMoves.length === 0 ? (
          <Text style={styles.historyEmpty}>Your move-by-move report will appear here.</Text>
        ) : (
          <View style={styles.historyList}>
            {[...gradedMoves].reverse().map((entry) => (
              <View key={entry.index} style={styles.historyRow}>
                <Text style={styles.historyNumber}>{entry.index + 1}</Text>
                <View style={[styles.historyColor, entry.player === 'Red' ? styles.redDot : styles.blueDot]} />
                <Text style={styles.historyMove}>{moveLabel(entry)}</Text>
                {entry.pending ? (
                  <Text style={styles.historyQuality}>Analyzing</Text>
                ) : (
                  <MoveQualityBadge compact grade={entry.grade} />
                )}
              </View>
            ))}
          </View>
        )}
      </View>
    </View>
  );
}

/** One move played on this board, and who played it. */
interface BoardMove {
  move: Move;
  mover: SideColor;
}

/** A move taken back, kept so it can be replayed forwards. */
interface RedoStep {
  game: AnalysisGame;
  historyEntry: BoardMove | null;
}

/**
 * The page: read the mode out of the URL, then hand it to the board.
 *
 * Split for the same reason the bot battle is — the board's hooks all need a
 * mode, and a static page learns its query string one render after it mounts.
 */
export default function AnalysisScreen() {
  const modes = useGameStore((state) => state.modes);
  // The mode travels in the URL, so `/analysis?mode=V5` is a page somebody can
  // link to. An unknown or absent id falls back to the first playable mode.
  const { params, settled } = useSettledSearchParams<{ mode: string }>();
  const mode =
    modes.find((candidate) => candidate.id === params.mode) ??
    modes.find((candidate) => candidate.playable) ??
    modes[0];

  if (!settled || !mode) {
    return (
      <SafeAreaView style={styles.safeArea} edges={['top', 'right', 'bottom', 'left']}>
        <View style={styles.screen}>
          <Text style={styles.cardEyebrow}>ANALYSIS BOARD</Text>
          <Text style={styles.cardTitle}>Setting up the board…</Text>
        </View>
      </SafeAreaView>
    );
  }

  // Keyed by mode so switching modes rebuilds the board rather than trying to
  // carry a line from one set of rules into another.
  return <AnalysisBoard key={mode.id} mode={mode} />;
}

function AnalysisBoard({ mode }: { mode: ModeDefinition }) {
  const router = useRouter();
  const modes = useGameStore((state) => state.modes);
  const draggingPiece = usePieceDrag((state) => state.dragging);
  const [game, setGame] = useState(() => createAnalysisGame(mode));
  const [analysisMode, setAnalysisMode] = useState<AnalysisSearchMode>('standard');
  const [history, setHistory] = useState<BoardMove[]>([]);
  const [pastGames, setPastGames] = useState<AnalysisGame[]>([]);
  const [redoMoves, setRedoMoves] = useState<RedoStep[]>([]);
  const [startingPosition, setStartingPosition] = useState<StartingPosition>(
    () => mode.startingPosition,
  );
  const [positionModalOpen, setPositionModalOpen] = useState(false);
  const [positionModalInitial, setPositionModalInitial] = useState<StartingPosition>(
    () => mode.startingPosition,
  );
  const [pgnModalOpen, setPgnModalOpen] = useState(false);
  const handReview = useReviewHandoff((state) => state.hand);

  // The interactive search: what the engine thinks of the position on screen
  // right now, redone from scratch whenever that position changes. It drives
  // the arrows, the eval bar and the ranked lines, and it grades nothing —
  // grades come from the walk below, which measures a played move against the
  // best move of the same search rather than across two of them.
  //
  // The same hook the review's off-record branches use, so the two boards
  // cannot disagree about how a position is searched.
  const positionAnalysis = usePositionAnalysis({
    position: game,
    history: pastGames,
    limits: ANALYSIS_PRESETS[analysisMode],
  });
  const analysis = positionAnalysis.analysis;
  const engineState = positionAnalysis.status;
  const engineError = positionAnalysis.error;

  // The grades. This is the same walk the review screen and the bot battle
  // run, over the line played on this board: take a move back and the grades
  // for the moves before it survive, play a different one and only that move
  // is regraded.
  const positions = useMemo(() => [...pastGames, game], [game, pastGames]);
  const moves = useMemo(
    () => history.map((entry) => ({ ...entry.move, player: entry.mover })),
    [history],
  );
  const gradeAnalysis = useGameAnalysis({
    mode: game.mode,
    moves,
    positions,
    preset: GRADE_PRESETS[analysisMode],
    // Another move can always arrive on a board somebody is playing on, so the
    // position on screen is not graded here — the search above already covers
    // it, and grading it now would cost the move played out of it its grade.
    streaming: game.status === 'InProgress',
  });
  const gradedMoves = gradeAnalysis.report?.moves ?? [];
  const lastPlay = gradedMoves[gradedMoves.length - 1];
  const lastGradedMove: GradedMove<BoardPlay> | null =
    lastPlay && !lastPlay.pending ? lastPlay : null;

  const { boardSize, isWide } = useBoardLayout({
    sidePanel: 430,
    narrowHeightShare: 0.55,
  });
  const canMove = engineState === 'ready' && game.status === 'InProgress';

  const performMove = (
    from: Position,
    to: Position,
    { allowWhileThinking = false }: { allowWhileThinking?: boolean } = {},
  ) => {
    if ((!canMove && !allowWhileThinking) || game.status !== 'InProgress' || !analysis) return;
    const result = applyAnalysisMove(game, from, to);
    if (!result) return;

    setPastGames((positions) => [...positions, game]);
    setRedoMoves([]);
    // Only what the move was. Its grade is the analysis walk's business, and
    // the walk is looking at the position this move was played from.
    setHistory((entries) => [...entries, { move: { from, to }, mover: result.mover }]);
    clearSelection();
    setGame(result.game);
  };

  const selection = useBoardSelection({
    game,
    disabled: !canMove,
    onMove: (from, to) => performMove(from, to),
  });
  const { clearSelection, selectedTile, validMoves } = selection;

  // The hand-built position is what makes this the endgame-study board: set a
  // rook and its hunter down with `SET POSITION`, then walk one of them a
  // square at a time and watch the verdict turn over.
  const reachTool = useReach(game);

  const undoMove = useCallback(() => {
    const previousGame = pastGames[pastGames.length - 1];
    if (!previousGame) return;

    const historyEntry = history[history.length - 1] ?? null;
    clearSelection();
    setPastGames(pastGames.slice(0, -1));
    setRedoMoves((taken) => [...taken, { game, historyEntry }]);
    setHistory(history.slice(0, -1));
    setGame(previousGame);
  }, [clearSelection, game, history, pastGames]);

  const redoMove = useCallback(() => {
    const nextMove = redoMoves[redoMoves.length - 1];
    if (!nextMove) return;

    clearSelection();
    setPastGames((positions) => [...positions, game]);
    setRedoMoves(redoMoves.slice(0, -1));
    setHistory((entries) =>
      nextMove.historyEntry ? [...entries, nextMove.historyEntry] : entries,
    );
    setGame(nextMove.game);
  }, [clearSelection, game, redoMoves]);

  const canUndo = pastGames.length > 0;
  const canRedo = redoMoves.length > 0;

  useReplayKeyboard({
    onFirst: undoMove,
    onLast: redoMove,
    onNext: redoMove,
    onPrevious: undoMove,
  });

  const makeBestMove = () => {
    const bestMove = analysis?.lines[0];
    if (game.status !== 'InProgress' || !bestMove) return;
    performMove(bestMove.from, bestMove.to, { allowWhileThinking: true });
  };

  const startFromPosition = (position: StartingPosition) => {
    clearSelection();
    setHistory([]);
    setPastGames([]);
    setRedoMoves([]);
    setStartingPosition(position);
    setGame(createAnalysisGame(mode, position));
    setPositionModalOpen(false);
  };

  const reset = () => startFromPosition(startingPosition);

  const board = (
    <View style={styles.boardWithEval}>
      <EvalBar height={boardSize} redScore={analysis?.redScore} />
      <Board
        analysisArrows={analysis?.lines ?? []}
        boardSize={boardSize}
        canMove={canMove}
        grid={game.grid}
        lastMove={history[history.length - 1]?.move ?? null}
        lastMoveGrade={lastGradedMove?.grade ?? null}
        modeId={game.mode.id}
        movableColor={game.currentTurn}
        onPieceDrop={performMove}
        onTilePress={(square) => {
          if (reachTool.handleTilePress(square)) return;
          selection.selectTile(square);
        }}
        overlay={reachTool.overlay}
        playerColor="Red"
        selectedTile={selectedTile}
        validMoves={validMoves}
      />
    </View>
  );

  const panel = (
    <>
      <AnalysisPanel
        analysis={analysis}
        analysisMode={analysisMode}
        canMakeBestMove={game.status === 'InProgress' && Boolean(analysis?.lines[0])}
        engineState={engineState}
        game={game}
        gradeError={gradeAnalysis.error}
        gradedMoves={gradedMoves}
        onAnalysisModeChange={setAnalysisMode}
        onMakeBestMove={makeBestMove}
        onSetPosition={() => {
          setPositionModalInitial(startingPositionFromGrid(game.grid));
          setPositionModalOpen(true);
        }}
        onToggleReach={reachTool.available ? reachTool.toggle : undefined}
        reachShowing={reachTool.active}
      />
      <ReachPanel tool={reachTool} />
    </>
  );

  return (
    <SafeAreaView style={styles.safeArea} edges={['top', 'right', 'bottom', 'left']}>
      <View style={styles.screen}>
        <View style={styles.topBar}>
          <Pressable
            accessibilityLabel="Return to lobby"
            accessibilityRole="button"
            onPress={() => router.back()}
            style={({ pressed }) => [styles.backButton, pressed && styles.buttonPressed]}
          >
            <Text style={styles.backIcon}>‹</Text>
          </Pressable>
          <View style={styles.titleCopy}>
            <Text numberOfLines={1} style={styles.kicker}>
              {mode.shortCode} · SELF ANALYSIS
            </Text>
            <Text numberOfLines={1} style={styles.title}>
              {mode.name}
            </Text>
          </View>
          <View style={styles.headerActions}>
            <Pressable
              accessibilityLabel="Load a game analysis from PGN"
              accessibilityRole="button"
              onPress={() => setPgnModalOpen(true)}
              style={({ pressed }) => [styles.resetButton, pressed && styles.buttonPressed]}
            >
              <Text style={styles.resetText}>LOAD PGN</Text>
            </Pressable>
            <Pressable
              accessibilityHint="You can also press the left arrow key."
              accessibilityLabel="Undo move"
              accessibilityRole="button"
              accessibilityState={{ disabled: !canUndo }}
              disabled={!canUndo}
              onPress={undoMove}
              style={({ pressed }) => [
                styles.historyButton,
                !canUndo && styles.headerButtonDisabled,
                pressed && canUndo && styles.buttonPressed,
              ]}
            >
              <Text style={styles.historyButtonArrow}>←</Text>
              <Text style={styles.historyButtonText}>Undo</Text>
            </Pressable>
            <Pressable
              accessibilityHint="You can also press the right arrow key."
              accessibilityLabel="Redo move"
              accessibilityRole="button"
              accessibilityState={{ disabled: !canRedo }}
              disabled={!canRedo}
              onPress={redoMove}
              style={({ pressed }) => [
                styles.historyButton,
                !canRedo && styles.headerButtonDisabled,
                pressed && canRedo && styles.buttonPressed,
              ]}
            >
              <Text style={styles.historyButtonText}>Redo</Text>
              <Text style={styles.historyButtonArrow}>→</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              onPress={reset}
              style={({ pressed }) => [styles.resetButton, pressed && styles.buttonPressed]}
            >
              <Text style={styles.resetText}>Reset</Text>
            </Pressable>
          </View>
        </View>

        {isWide ? (
          <View style={styles.wideLayout}>
            <View style={styles.boardColumn}>{board}</View>
            <ScrollView
              contentContainerStyle={styles.widePanelContent}
              showsVerticalScrollIndicator={false}
              style={[styles.widePanel, { maxHeight: boardSize }]}
            >
              {panel}
            </ScrollView>
          </View>
        ) : (
          <ScrollView
            contentContainerStyle={styles.mobileContent}
            // The board is inside this scroller on a phone, and dragging a
            // piece must not drag the page with it.
            scrollEnabled={!draggingPiece}
            showsVerticalScrollIndicator={false}
          >
            {board}
            {panel}
          </ScrollView>
        )}

        {engineError && (
          <View style={styles.errorBanner}>
            <Text style={styles.errorText}>{engineError}</Text>
          </View>
        )}
      </View>
      <PositionSetupModal
        initialPosition={positionModalInitial}
        mode={mode}
        onApply={startFromPosition}
        onClose={() => setPositionModalOpen(false)}
        visible={positionModalOpen}
      />
      <PGNImportModal
        onClose={() => setPgnModalOpen(false)}
        onLoad={(pgn) => {
          // Parsed here so an unreadable record fails in the modal rather than
          // on the next page.
          reviewSourceFromPGN(pgn, modes);
          setPgnModalOpen(false);
          handReview({ pgn, playerColor: null });
          router.push(links.review());
        }}
        visible={pgnModalOpen}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: colors.background },
  screen: {
    flex: 1,
    width: '100%',
    maxWidth: 1200,
    alignSelf: 'center',
    paddingHorizontal: 12,
    paddingBottom: 10,
  },
  topBar: {
    minHeight: 64,
    flexDirection: 'row',
    alignItems: 'center',
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    marginBottom: 12,
  },
  backButton: {
    width: 38,
    height: 38,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.large,
    backgroundColor: colors.surface,
  },
  backIcon: { color: colors.text, fontSize: 31, lineHeight: 31, marginTop: -3 },
  titleCopy: { flex: 1, minWidth: 0, paddingHorizontal: 10 },
  kicker: { color: colors.accentBright, fontSize: 8, fontWeight: '900', letterSpacing: 1.35 },
  title: { color: colors.textStrong, fontSize: 20, fontWeight: '900', marginTop: 2 },
  resetButton: {
    minHeight: 38,
    justifyContent: 'center',
    paddingHorizontal: 14,
    paddingVertical: 9,
    borderRadius: radius.medium,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    backgroundColor: colors.surface,
  },
  resetText: { color: colors.textSoft, fontSize: 10, fontWeight: '900' },
  headerActions: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  historyButton: {
    minWidth: 54,
    minHeight: 38,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    paddingHorizontal: 7,
    borderRadius: radius.medium,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    backgroundColor: colors.surface,
  },
  headerButtonDisabled: { opacity: 0.35 },
  historyButtonArrow: { color: colors.textMuted, fontSize: 14, fontWeight: '900' },
  historyButtonText: { color: colors.textSoft, fontSize: 9, fontWeight: '900' },
  buttonPressed: { opacity: 0.68 },
  wideLayout: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'center',
    gap: 18,
  },
  boardColumn: { alignItems: 'center' },
  boardWithEval: { flexDirection: 'row', alignItems: 'stretch', gap: 7 },
  widePanel: { width: 350 },
  widePanelContent: { paddingBottom: 18, gap: 10 },
  mobileContent: { alignItems: 'center', paddingBottom: 24, gap: 14 },
  panelStack: { width: '100%', gap: 10 },
  coachCard: {
    padding: 14,
    borderRadius: radius.large,
    borderWidth: 1,
    borderColor: colors.accentBorder,
    backgroundColor: colors.accentSurface,
  },
  cardHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  cardEyebrow: { color: colors.textFaint, fontSize: 8, fontWeight: '900', letterSpacing: 1.2 },
  cardTitle: { color: colors.textStrong, fontSize: 17, fontWeight: '900', marginTop: 5 },
  cardBody: { color: colors.accentSoft, fontSize: 10, lineHeight: 15, marginTop: 8 },
  analysisModeRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 11 },
  analysisModeLabel: { color: colors.textFaint, fontSize: 7, fontWeight: '900', letterSpacing: 1 },
  analysisModeButton: {
    minHeight: 28,
    justifyContent: 'center',
    paddingHorizontal: 9,
    borderRadius: radius.small,
    borderWidth: 1,
    borderColor: colors.accentBorder,
    backgroundColor: colors.surfaceRaised,
  },
  analysisModeButtonActive: { borderColor: colors.accent, backgroundColor: colors.accentSurfaceRaised },
  analysisModeButtonText: { color: colors.textMuted, fontSize: 7, fontWeight: '900' },
  analysisModeButtonTextActive: { color: colors.accentSoft },
  setPositionButton: {
    minHeight: 28,
    justifyContent: 'center',
    marginLeft: 'auto',
    paddingHorizontal: 9,
    borderRadius: radius.small,
    borderWidth: 1,
    borderColor: colors.accent,
  },
  setPositionButtonText: { color: colors.accentSoft, fontSize: 7, fontWeight: '900' },
  bestMoveButton: {
    minHeight: 47,
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 12,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: radius.medium,
    backgroundColor: colors.accent,
  },
  bestMoveButtonDisabled: { opacity: 0.4 },
  bestMoveButtonCopy: { flex: 1 },
  bestMoveButtonText: { color: colors.textStrong, fontSize: 11, fontWeight: '900' },
  bestMoveButtonDetail: { color: colors.accentSurface, fontSize: 8, fontWeight: '800', marginTop: 2 },
  bestMoveButtonArrow: { color: colors.textStrong, fontSize: 20, fontWeight: '900' },
  lastMoveCard: {
    padding: 13,
    borderRadius: 11,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  lastMoveTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  lastMoveNotation: { color: colors.textStrong, fontSize: 16, fontWeight: '900', marginTop: 4 },
  bestMoveCopy: { color: colors.textMuted, fontSize: 9, marginTop: 8 },
  historyCard: {
    padding: 13,
    borderRadius: 11,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  historyEmpty: { color: colors.textFaint, fontSize: 10, marginTop: 10 },
  historyList: { marginTop: 8 },
  historyRow: { minHeight: 32, flexDirection: 'row', alignItems: 'center', borderTopWidth: 1, borderTopColor: colors.border },
  historyNumber: { width: 24, color: colors.textFaint, fontSize: 9, fontWeight: '800' },
  historyColor: { width: 7, height: 7, borderRadius: 4, marginRight: 8 },
  redDot: { backgroundColor: players.Red.strong },
  blueDot: { backgroundColor: players.Blue.strong },
  historyMove: { flex: 1, color: colors.textSoft, fontSize: 10, fontWeight: '800' },
  historyQuality: { color: colors.textMuted, fontSize: 9, fontWeight: '900' },
  errorBanner: { position: 'absolute', right: 12, bottom: 12, left: 12, padding: 11, borderRadius: radius.medium, backgroundColor: colors.dangerSurface },
  errorText: { color: colors.dangerText, fontSize: 10, fontWeight: '700', textAlign: 'center' },
});
