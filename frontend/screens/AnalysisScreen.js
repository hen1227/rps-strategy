import { useCallback, useEffect, useRef, useState } from 'react';
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
import TerritoryMeter from '../components/TerritoryMeter';
import {
  applyAnalysisMove,
  classifyMove,
  createAnalysisGame,
  moveLabel,
  validMovesFor,
} from '../engine/analysisGame';
import { ANALYSIS_PRESETS, analyzePosition } from '../engine/rpsfishClient';

const QUALITY_COLORS = {
  best: '#51d6a9',
  excellent: '#74c8ff',
  good: '#a7cf78',
  inaccuracy: '#e6c15a',
  mistake: '#ef9858',
  blunder: '#ef6565',
};

const samePosition = (first, second) => first?.x === second?.x && first?.y === second?.y;

const positionForEngine = (game) => ({
  currentTurn: game.currentTurn,
  grid: game.grid,
  modeId: game.mode.id,
  moveNumber: game.moveNumber,
});

const formatScore = (score) => {
  if (score === undefined || score === null) return '—';
  if (Math.abs(score) >= 29_000) {
    return `${score >= 0 ? '' : '−'}M${Math.max(1, 30_000 - Math.abs(score))}`;
  }
  const value = score / 100;
  return `${value >= 0 ? '+' : '−'}${Math.abs(value).toFixed(2)}`;
};

const confidenceLabel = (confidence) => {
  if (confidence >= 80) return 'HIGH';
  if (confidence >= 50) return 'MEDIUM';
  return 'LOW';
};

const variationLabel = (line) =>
  line.principalVariation
    ?.slice(1, 5)
    .map(moveLabel)
    .join(' · ');

function EvalBar({ height, redScore }) {
  const score = redScore ?? 0;
  const redShare = Math.max(2, Math.min(98, 50 + 48 * Math.tanh(score / 900)));
  const blueShare = 100 - redShare;

  return (
    <View
      accessibilityLabel={`Evaluation ${formatScore(score)} for Red`}
      style={[styles.evalBar, { height }]}
    >
      <View style={[styles.blueEval, { height: `${blueShare}%` }]}>
        <Text style={styles.blueEvalSide}>B</Text>
      </View>
      <View style={[styles.redEval, { height: `${redShare}%` }]}>
        <Text style={styles.redEvalSide}>R</Text>
      </View>
      <View style={[styles.evalDivider, { top: `${blueShare}%` }]} />
      <View style={[styles.evalBadge, score < 0 && styles.evalBadgeOnBlue]}>
        <Text style={[styles.evalValue, score < 0 && styles.evalValueOnBlue]}>
          {formatScore(score)}
        </Text>
      </View>
    </View>
  );
}

function AnalysisPanel({
  analysis,
  analysisMode,
  canMakeBestMove,
  engineState,
  game,
  history,
  onAnalysisModeChange,
  onMakeBestMove,
}) {
  const lastMove = history[history.length - 1];
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
          {engineState === 'thinking' && <ActivityIndicator color="#51d6a9" size="small" />}
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
                {lastMove.number}. {moveLabel(lastMove.move)}
              </Text>
            </View>
            {lastMove.quality ? (
              <View
                style={[
                  styles.qualityBadge,
                  { backgroundColor: QUALITY_COLORS[lastMove.quality.key] },
                ]}
              >
                <Text style={styles.qualityText}>{lastMove.quality.label}</Text>
              </View>
            ) : (
              <ActivityIndicator color="#b6bec8" size="small" />
            )}
          </View>
          <Text style={styles.bestMoveCopy}>
            Best was {lastMove.bestMove ? moveLabel(lastMove.bestMove) : 'not available'}
            {lastMove.quality ? ` · ${formatScore(lastMove.quality.loss)} lost` : ''}
          </Text>
        </View>
      )}

      <View style={styles.linesCard}>
        <View style={styles.linesHeader}>
          <Text style={styles.cardEyebrow}>TOP MOVES FOR {activeColor.toUpperCase()}</Text>
          {analysis && (
            <Text style={styles.engineMeta}>
              {analysisMode.toUpperCase()} · DEPTH {analysis.depth}/{analysis.selectiveDepth} ·{' '}
              {analysis.nodes.toLocaleString()} NODES · {confidenceLabel(analysis.confidence)}{' '}
              CONFIDENCE
            </Text>
          )}
        </View>
        {analysis?.lines.length ? (
          analysis.lines.map((line, index) => (
            <View key={`${line.from.x}:${line.from.y}-${line.to.x}:${line.to.y}`} style={styles.lineRow}>
              <View
                style={[
                  styles.lineRank,
                  { backgroundColor: ['#51d6a9', '#55a9ff', '#f0b857'][index] },
                ]}
              >
                <Text style={styles.lineRankText}>{index + 1}</Text>
              </View>
              <View style={styles.lineCopy}>
                <Text style={styles.lineMove}>{moveLabel(line)}</Text>
                {variationLabel(line) ? (
                  <Text numberOfLines={1} style={styles.lineVariation}>
                    then {variationLabel(line)}
                  </Text>
                ) : null}
              </View>
              <Text style={styles.lineScore}>{formatScore(line.score)}</Text>
            </View>
          ))
        ) : (
          <View style={styles.emptyLines}>
            <Text style={styles.emptyLinesText}>
              {engineState === 'error' ? 'Engine analysis unavailable.' : 'No legal continuation.'}
            </Text>
          </View>
        )}
      </View>

      <View style={styles.historyCard}>
        <Text style={styles.cardEyebrow}>MOVE QUALITY</Text>
        {history.length === 0 ? (
          <Text style={styles.historyEmpty}>Your move-by-move report will appear here.</Text>
        ) : (
          <View style={styles.historyList}>
            {[...history].reverse().map((entry) => (
              <View key={entry.number} style={styles.historyRow}>
                <Text style={styles.historyNumber}>{entry.number}</Text>
                <View style={[styles.historyColor, entry.mover === 'Red' ? styles.redDot : styles.blueDot]} />
                <Text style={styles.historyMove}>{moveLabel(entry.move)}</Text>
                <Text
                  style={[
                    styles.historyQuality,
                    entry.quality && { color: QUALITY_COLORS[entry.quality.key] },
                  ]}
                >
                  {entry.quality?.label ?? 'Analyzing'}
                </Text>
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
  const [game, setGame] = useState(() => createAnalysisGame(mode));
  const [selectedTile, setSelectedTile] = useState(null);
  const [validMoves, setValidMoves] = useState([]);
  const [analysis, setAnalysis] = useState(null);
  const [analysisMode, setAnalysisMode] = useState('standard');
  const [engineState, setEngineState] = useState('thinking');
  const [engineError, setEngineError] = useState(null);
  const [history, setHistory] = useState([]);
  const [pendingReview, setPendingReview] = useState(null);
  const [pastGames, setPastGames] = useState([]);
  const [redoMoves, setRedoMoves] = useState([]);
  const requestSequence = useRef(0);

  useEffect(() => {
    const requestId = ++requestSequence.current;
    const controller = new AbortController();
    setEngineState('thinking');
    setEngineError(null);

    analyzePosition(
      {
        ...positionForEngine(game),
        history: pastGames.map(positionForEngine),
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
        if (pendingReview) {
          const playedScore = pendingReview.lineScore ?? -result.score;
          const quality = classifyMove(pendingReview.bestScore, playedScore);
          setHistory((entries) =>
            entries.map((entry) =>
              entry.number === pendingReview.number ? { ...entry, playedScore, quality } : entry,
            ),
          );
          setPendingReview(null);
        }
      })
      .catch((error) => {
        if (requestSequence.current !== requestId) return;
        if (error.name === 'AbortError') return;
        setEngineState('error');
        setEngineError(error.message);
        if (pendingReview?.lineScore !== undefined) {
          const quality = classifyMove(pendingReview.bestScore, pendingReview.lineScore);
          setHistory((entries) =>
            entries.map((entry) =>
              entry.number === pendingReview.number ? { ...entry, quality } : entry,
            ),
          );
          setPendingReview(null);
        }
      });
    return () => controller.abort();
  }, [analysisMode, game, pastGames]);

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

    const chosenLine = analysis.lines.find(
      (line) => samePosition(line.from, from) && samePosition(line.to, to),
    );
    const number = result.game.moveNumber;
    const bestMove = analysis.lines[0]
      ? { from: analysis.lines[0].from, to: analysis.lines[0].to }
      : null;
    const bestScore = analysis.lines[0]?.score ?? analysis.score;
    const playedScore = chosenLine?.score;
    const quality = playedScore === undefined ? null : classifyMove(bestScore, playedScore);
    requestSequence.current += 1;
    setEngineState('thinking');
    setAnalysis(null);
    setPastGames((positions) => [...positions, game]);
    setRedoMoves([]);
    setHistory((entries) => {
      const reviewedEntries = pendingReview
        ? entries.map((entry) => {
            if (entry.number !== pendingReview.number) return entry;
            const reviewedScore = pendingReview.lineScore ?? -analysis.score;
            return {
              ...entry,
              playedScore: reviewedScore,
              quality: classifyMove(pendingReview.bestScore, reviewedScore),
            };
          })
        : entries;
      return [
        ...reviewedEntries,
        {
          bestMove,
          move: { from, to },
          mover: result.mover,
          number,
          playedScore,
          quality,
        },
      ];
    });
    setPendingReview(
      playedScore === undefined
        ? {
            bestScore,
            number,
          }
        : null,
    );
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
    setRedoMoves((moves) => [...moves, { game, historyEntry, pendingReview }]);
    setHistory(history.slice(0, -1));
    setPendingReview(null);
    setGame(previousGame);
  }, [game, history, pastGames, pendingReview, prepareForPositionChange]);

  const redoMove = useCallback(() => {
    if (redoMoves.length === 0) return;

    const nextMove = redoMoves[redoMoves.length - 1];
    prepareForPositionChange();
    setPastGames((positions) => [...positions, game]);
    setRedoMoves(redoMoves.slice(0, -1));
    setHistory((entries) =>
      nextMove.historyEntry ? [...entries, nextMove.historyEntry] : entries,
    );
    setPendingReview(nextMove.pendingReview);
    setGame(nextMove.game);
  }, [game, prepareForPositionChange, redoMoves]);

  const canUndo = pastGames.length > 0;
  const canRedo = redoMoves.length > 0;

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;

    const handleKeyDown = (event) => {
      const target = event.target;
      const isEditing =
        target?.isContentEditable ||
        target?.tagName === 'INPUT' ||
        target?.tagName === 'TEXTAREA' ||
        target?.tagName === 'SELECT';
      if (
        event.defaultPrevented ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey ||
        isEditing
      ) {
        return;
      }

      if (event.key === 'ArrowLeft' && canUndo) {
        event.preventDefault();
        undoMove();
      } else if (event.key === 'ArrowRight' && canRedo) {
        event.preventDefault();
        redoMove();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [canRedo, canUndo, redoMove, undoMove]);

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

  const reset = () => {
    requestSequence.current += 1;
    setSelectedTile(null);
    setValidMoves([]);
    setAnalysis(null);
    setHistory([]);
    setPendingReview(null);
    setPastGames([]);
    setRedoMoves([]);
    setEngineState('thinking');
    setEngineError(null);
    setGame(createAnalysisGame(mode));
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
      history={history}
      onAnalysisModeChange={setAnalysisMode}
      onMakeBestMove={makeBestMove}
    />
  );

  return (
    <SafeAreaView style={styles.safeArea} edges={['top', 'right', 'bottom', 'left']}>
      <View style={styles.screen}>
        <View style={styles.topBar}>
          <Pressable
            accessibilityLabel="Back to game modes"
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
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: '#0e1116' },
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
    borderBottomColor: '#242b34',
    marginBottom: 12,
  },
  backButton: {
    width: 38,
    height: 38,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 10,
    backgroundColor: '#1b212a',
  },
  backIcon: { color: '#e9edf1', fontSize: 31, lineHeight: 31, marginTop: -3 },
  titleCopy: { flex: 1, minWidth: 0, paddingHorizontal: 10 },
  kicker: { color: '#51d6a9', fontSize: 8, fontWeight: '900', letterSpacing: 1.35 },
  title: { color: '#f4f6f8', fontSize: 20, fontWeight: '900', marginTop: 2 },
  resetButton: {
    minHeight: 38,
    justifyContent: 'center',
    paddingHorizontal: 14,
    paddingVertical: 9,
    borderRadius: 9,
    borderWidth: 1,
    borderColor: '#37414d',
    backgroundColor: '#1b212a',
  },
  resetText: { color: '#cbd2d9', fontSize: 10, fontWeight: '900' },
  headerActions: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  historyButton: {
    minWidth: 54,
    minHeight: 38,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    paddingHorizontal: 7,
    borderRadius: 9,
    borderWidth: 1,
    borderColor: '#37414d',
    backgroundColor: '#1b212a',
  },
  headerButtonDisabled: { opacity: 0.35 },
  historyButtonArrow: { color: '#8da0ae', fontSize: 14, fontWeight: '900' },
  historyButtonText: { color: '#cbd2d9', fontSize: 9, fontWeight: '900' },
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
  evalBar: {
    position: 'relative',
    width: 31,
    overflow: 'hidden',
    borderRadius: 7,
    borderWidth: 2,
    borderColor: '#202631',
    backgroundColor: '#202631',
  },
  blueEval: { width: '100%', alignItems: 'center', paddingTop: 5, backgroundColor: '#3f77aa' },
  redEval: { width: '100%', alignItems: 'center', justifyContent: 'flex-end', paddingBottom: 5, backgroundColor: '#c84b44' },
  blueEvalSide: { color: '#dcecff', fontSize: 8, fontWeight: '900' },
  redEvalSide: { color: '#ffe1df', fontSize: 8, fontWeight: '900' },
  evalDivider: { position: 'absolute', left: 0, width: '100%', height: 2, backgroundColor: '#f5f7f8' },
  evalBadge: {
    position: 'absolute',
    right: 2,
    bottom: 19,
    left: 2,
    alignItems: 'center',
    paddingVertical: 3,
    borderRadius: 4,
    backgroundColor: 'rgba(255,255,255,0.9)',
  },
  evalBadgeOnBlue: { top: 19, bottom: 'auto', backgroundColor: 'rgba(11,18,26,0.86)' },
  evalValue: { color: '#a33531', fontSize: 7, fontWeight: '900', fontVariant: ['tabular-nums'] },
  evalValueOnBlue: { color: '#dcecff' },
  widePanel: { width: 350 },
  widePanelContent: { paddingBottom: 18 },
  mobileContent: { alignItems: 'center', paddingBottom: 24, gap: 14 },
  panelStack: { width: '100%', gap: 10 },
  coachCard: {
    padding: 14,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#2e3d3a',
    backgroundColor: '#15221f',
  },
  cardHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  cardEyebrow: { color: '#71808e', fontSize: 8, fontWeight: '900', letterSpacing: 1.2 },
  cardTitle: { color: '#f2f5f6', fontSize: 17, fontWeight: '900', marginTop: 5 },
  cardBody: { color: '#8fa49f', fontSize: 10, lineHeight: 15, marginTop: 8 },
  analysisModeRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 11 },
  analysisModeLabel: { color: '#65736f', fontSize: 7, fontWeight: '900', letterSpacing: 1 },
  analysisModeButton: {
    minHeight: 28,
    justifyContent: 'center',
    paddingHorizontal: 9,
    borderRadius: 7,
    borderWidth: 1,
    borderColor: '#34453f',
    backgroundColor: '#182a25',
  },
  analysisModeButtonActive: { borderColor: '#51d6a9', backgroundColor: '#24453b' },
  analysisModeButtonText: { color: '#799087', fontSize: 7, fontWeight: '900' },
  analysisModeButtonTextActive: { color: '#85e9c9' },
  bestMoveButton: {
    minHeight: 47,
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 12,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 9,
    backgroundColor: '#51d6a9',
  },
  bestMoveButtonDisabled: { opacity: 0.4 },
  bestMoveButtonCopy: { flex: 1 },
  bestMoveButtonText: { color: '#10201d', fontSize: 11, fontWeight: '900' },
  bestMoveButtonDetail: { color: '#296758', fontSize: 8, fontWeight: '800', marginTop: 2 },
  bestMoveButtonArrow: { color: '#10201d', fontSize: 20, fontWeight: '900' },
  lastMoveCard: {
    padding: 13,
    borderRadius: 11,
    borderWidth: 1,
    borderColor: '#303945',
    backgroundColor: '#171c23',
  },
  lastMoveTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  lastMoveNotation: { color: '#f1f4f6', fontSize: 16, fontWeight: '900', marginTop: 4 },
  qualityBadge: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 7 },
  qualityText: { color: '#10201d', fontSize: 9, fontWeight: '900' },
  bestMoveCopy: { color: '#89939f', fontSize: 9, marginTop: 8 },
  linesCard: {
    overflow: 'hidden',
    borderRadius: 11,
    borderWidth: 1,
    borderColor: '#303945',
    backgroundColor: '#171c23',
  },
  linesHeader: { paddingHorizontal: 13, paddingTop: 12, paddingBottom: 9 },
  engineMeta: { color: '#566270', fontSize: 7, fontWeight: '800', marginTop: 4 },
  lineRow: {
    minHeight: 45,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    borderTopWidth: 1,
    borderTopColor: '#252c36',
  },
  lineRank: { width: 23, height: 23, alignItems: 'center', justifyContent: 'center', borderRadius: 12 },
  lineRankText: { color: '#10201d', fontSize: 10, fontWeight: '900' },
  lineCopy: { flex: 1, minWidth: 0, marginLeft: 10 },
  lineMove: { color: '#e5e9ed', fontSize: 13, fontWeight: '900' },
  lineVariation: { color: '#64717e', fontSize: 7, fontWeight: '700', marginTop: 2 },
  lineScore: { color: '#abb5bf', fontSize: 11, fontWeight: '900', fontVariant: ['tabular-nums'] },
  emptyLines: { minHeight: 48, alignItems: 'center', justifyContent: 'center', borderTopWidth: 1, borderTopColor: '#252c36' },
  emptyLinesText: { color: '#6f7a87', fontSize: 10 },
  historyCard: {
    padding: 13,
    borderRadius: 11,
    borderWidth: 1,
    borderColor: '#303945',
    backgroundColor: '#171c23',
  },
  historyEmpty: { color: '#6f7a87', fontSize: 10, marginTop: 10 },
  historyList: { marginTop: 8 },
  historyRow: { minHeight: 32, flexDirection: 'row', alignItems: 'center', borderTopWidth: 1, borderTopColor: '#252c36' },
  historyNumber: { width: 24, color: '#687381', fontSize: 9, fontWeight: '800' },
  historyColor: { width: 7, height: 7, borderRadius: 4, marginRight: 8 },
  redDot: { backgroundColor: '#c84b44' },
  blueDot: { backgroundColor: '#3f77aa' },
  historyMove: { flex: 1, color: '#cbd2d9', fontSize: 10, fontWeight: '800' },
  historyQuality: { color: '#7c8793', fontSize: 9, fontWeight: '900' },
  errorBanner: { position: 'absolute', right: 12, bottom: 12, left: 12, padding: 11, borderRadius: 9, backgroundColor: '#6f3539' },
  errorText: { color: '#ffe0de', fontSize: 10, fontWeight: '700', textAlign: 'center' },
});
