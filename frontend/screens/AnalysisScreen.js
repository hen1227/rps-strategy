import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import Board from '../components/Board';
import EngineLinesCard from '../components/EngineLinesCard';
import EvalBar from '../components/EvalBar';
import MoveQualityBadge from '../components/MoveQualityBadge';
import PGNImportModal from '../components/PGNImportModal';
import PositionSetupModal from '../components/PositionSetupModal';
import TerritoryMeter from '../components/TerritoryMeter';
import {
  applyAnalysisMove,
  createAnalysisGame,
  enginePosition,
  moveLabel,
  startingPositionFromGrid,
  validMovesFor,
} from '../engine/analysisGame';
import { reviewSourceFromPGN } from '../engine/gameReview';
import { ANALYSIS_PRESETS, analyzePosition } from '../engine/rpsfishClient';
import useGameAnalysis from '../hooks/useGameAnalysis';
import useReplayKeyboard from '../hooks/useReplayKeyboard';
import { useGameStore } from '../store/gameStore';
import { colors, players, radius } from '../theme';

const samePosition = (first, second) => first?.x === second?.x && first?.y === second?.y;

// The board's own search budget and the budget its grades are measured at are
// two different things: one is redone every time the position changes and only
// has to keep up with a person clicking, the other has to be worth writing a
// grade down from. They move together so that "GO DEEP" deepens both.
const GRADE_PRESETS = Object.freeze({ standard: 'standard', deep: 'deep' });

const confidenceLabel = (confidence) => {
  if (confidence >= 80) return 'HIGH';
  if (confidence >= 50) return 'MEDIUM';
  return 'LOW';
};

// A move can give up nothing without being the move the engine named, so
// "best was X" is only said when playing X would actually have been better.
const lastMoveVerdict = (entry) => {
  if (!entry.grade) return 'RPSFish is grading this move…';
  const best = entry.bestMove ? moveLabel(entry.bestMove) : 'not available';
  if (entry.grade.key === 'great') {
    return 'The only move that stayed within the Good threshold.';
  }
  if (entry.isTopMove) return `The engine's own choice at depth ${entry.depth}.`;
  if (entry.lossPercent < 0.05) return `As strong as ${best}.`;
  return `Best was ${best} · ${entry.lossPercent.toFixed(1)} points of expected score lost`;
};

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
}) {
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
          {['standard', 'deep'].map((searchMode) => (
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
            {lastMove.grade ? (
              <MoveQualityBadge grade={lastMove.grade} />
            ) : (
              <ActivityIndicator color={colors.textMuted} size="small" />
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
                {entry.grade ? (
                  <MoveQualityBadge compact grade={entry.grade} />
                ) : (
                  <Text style={styles.historyQuality}>Analyzing</Text>
                )}
              </View>
            ))}
          </View>
        )}
      </View>
    </View>
  );
}

export default function AnalysisScreen({ navigation, route }) {
  const { height, width } = useWindowDimensions();
  const mode = route.params?.mode;
  const modes = useGameStore((state) => state.modes);
  const [game, setGame] = useState(() => createAnalysisGame(mode));
  const [selectedTile, setSelectedTile] = useState(null);
  const [validMoves, setValidMoves] = useState([]);
  const [analysis, setAnalysis] = useState(null);
  const [analysisMode, setAnalysisMode] = useState('standard');
  const [engineState, setEngineState] = useState('thinking');
  const [engineError, setEngineError] = useState(null);
  const [history, setHistory] = useState([]);
  const [pastGames, setPastGames] = useState([]);
  const [redoMoves, setRedoMoves] = useState([]);
  const [startingPosition, setStartingPosition] = useState(() => mode.startingPosition);
  const [positionModalOpen, setPositionModalOpen] = useState(false);
  const [positionModalInitial, setPositionModalInitial] = useState(() => mode.startingPosition);
  const [pgnModalOpen, setPgnModalOpen] = useState(false);
  const requestSequence = useRef(0);

  // The interactive search: what the engine thinks of the position on screen
  // right now, redone from scratch whenever that position changes. It drives
  // the arrows, the eval bar and the ranked lines, and it grades nothing —
  // grades come from the walk below, which measures a played move against the
  // best move of the same search rather than across two of them.
  useEffect(() => {
    const requestId = ++requestSequence.current;
    const controller = new AbortController();
    setEngineState('thinking');
    setEngineError(null);

    analyzePosition(
      {
        ...enginePosition(game),
        history: pastGames.map(enginePosition),
      },
      {
        ...ANALYSIS_PRESETS[analysisMode],
        signal: controller.signal,
      },
      (update) => {
        if (requestSequence.current !== requestId) return;
        setAnalysis((current) =>
          current && current.depth > update.depth ? current : update,
        );
      },
    )
      .then((result) => {
        if (requestSequence.current !== requestId) return;
        setAnalysis((current) =>
          current && current.depth > result.depth ? current : result,
        );
        setEngineState('ready');
      })
      .catch((error) => {
        if (requestSequence.current !== requestId) return;
        if (error.name === 'AbortError') return;
        setEngineState('error');
        setEngineError(error.message);
      });
    return () => controller.abort();
  }, [analysisMode, game, pastGames]);

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

  const isWide = width >= 900 && width > height;
  const boardSize = Math.floor(
    Math.max(
      230,
      Math.min(
        620,
        isWide ? width - 430 : width - 58,
        isWide ? height - 112 : height * 0.55,
      ),
    ),
  );
  const canMove = engineState === 'ready' && game.status === 'InProgress';

  const performMove = (from, to, { allowWhileThinking = false } = {}) => {
    if ((!canMove && !allowWhileThinking) || game.status !== 'InProgress' || !analysis) return;
    const result = applyAnalysisMove(game, from, to);
    if (!result) return;

    requestSequence.current += 1;
    setEngineState('thinking');
    setAnalysis(null);
    setPastGames((positions) => [...positions, game]);
    setRedoMoves([]);
    // Only what the move was. Its grade is the analysis walk's business, and
    // the walk is looking at the position this move was played from.
    setHistory((entries) => [
      ...entries,
      { move: { from, to }, mover: result.mover },
    ]);
    setSelectedTile(null);
    setValidMoves([]);
    setGame(result.game);
  };

  const prepareForPositionChange = useCallback(() => {
    requestSequence.current += 1;
    setSelectedTile(null);
    setValidMoves([]);
    setAnalysis(null);
    setEngineState('thinking');
    setEngineError(null);
  }, []);

  const undoMove = useCallback(() => {
    if (pastGames.length === 0) return;

    const previousGame = pastGames[pastGames.length - 1];
    const historyEntry = history[history.length - 1] ?? null;
    prepareForPositionChange();
    setPastGames(pastGames.slice(0, -1));
    setRedoMoves((taken) => [...taken, { game, historyEntry }]);
    setHistory(history.slice(0, -1));
    setGame(previousGame);
  }, [game, history, pastGames, prepareForPositionChange]);

  const redoMove = useCallback(() => {
    if (redoMoves.length === 0) return;

    const nextMove = redoMoves[redoMoves.length - 1];
    prepareForPositionChange();
    setPastGames((positions) => [...positions, game]);
    setRedoMoves(redoMoves.slice(0, -1));
    setHistory((entries) =>
      nextMove.historyEntry ? [...entries, nextMove.historyEntry] : entries,
    );
    setGame(nextMove.game);
  }, [game, prepareForPositionChange, redoMoves]);

  const canUndo = pastGames.length > 0;
  const canRedo = redoMoves.length > 0;

  useReplayKeyboard({
    onNext: canRedo ? redoMove : undefined,
    onPrevious: canUndo ? undoMove : undefined,
  });

  const makeBestMove = () => {
    const bestMove = analysis?.lines[0];
    if (game.status !== 'InProgress' || !bestMove) return;
    performMove(bestMove.from, bestMove.to, { allowWhileThinking: true });
  };

  const selectTile = (position) => {
    if (!canMove) return;
    if (selectedTile && validMoves.some((move) => samePosition(move, position))) {
      performMove(selectedTile, position);
      return;
    }
    if (selectedTile && samePosition(selectedTile, position)) {
      setSelectedTile(null);
      setValidMoves([]);
      return;
    }
    const moves = validMovesFor(game, position);
    setSelectedTile(moves.length ? position : null);
    setValidMoves(moves);
  };

  const startFromPosition = (position) => {
    requestSequence.current += 1;
    setSelectedTile(null);
    setValidMoves([]);
    setAnalysis(null);
    setHistory([]);
    setPastGames([]);
    setRedoMoves([]);
    setEngineState('thinking');
    setEngineError(null);
    setStartingPosition(position);
    setGame(createAnalysisGame(mode, position));
    setPositionModalOpen(false);
  };

  const reset = () => {
    startFromPosition(startingPosition);
  };

  const board = (
    <View style={styles.boardWithEval}>
      <EvalBar height={boardSize} redScore={analysis?.redScore} />
      <Board
        analysisArrows={analysis?.lines ?? []}
        boardSize={boardSize}
        canMove={canMove}
        grid={game.grid}
        lastMove={history[history.length - 1]?.move ?? null}
        lastMoveGrade={gradedMoves[gradedMoves.length - 1]?.grade ?? null}
        modeId={game.mode.id}
        movableColor={game.currentTurn}
        onPieceDrop={performMove}
        onTilePress={selectTile}
        playerColor="Red"
        selectedTile={selectedTile}
        validMoves={validMoves}
      />
    </View>
  );

  const panel = (
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
    />
  );

  return (
    <SafeAreaView style={styles.safeArea} edges={['top', 'right', 'bottom', 'left']}>
      <View style={styles.screen}>
        <View style={styles.topBar}>
          <Pressable
            accessibilityLabel="Return to lobby"
            accessibilityRole="button"
            onPress={() => navigation.goBack()}
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
          reviewSourceFromPGN(pgn, modes);
          setPgnModalOpen(false);
          navigation.navigate('Review', { pgn });
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
  widePanelContent: { paddingBottom: 18 },
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
