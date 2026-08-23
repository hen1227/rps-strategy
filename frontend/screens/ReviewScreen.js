import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as Clipboard from 'expo-clipboard';
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

import AccuracyCard from '../components/AccuracyCard';
import AnalysisPresetPicker from '../components/AnalysisPresetPicker';
import Board from '../components/Board';
import EngineLinesCard from '../components/EngineLinesCard';
import EvalBar from '../components/EvalBar';
import EvalChart from '../components/EvalChart';
import GameChat from '../components/GameChat';
import MoveAnalysisList from '../components/MoveAnalysisList';
import MoveQualityBadge from '../components/MoveQualityBadge';
import ReplayControls from '../components/ReplayControls';
import TerritoryMeter from '../components/TerritoryMeter';
import { applyAnalysisMove, enginePosition, moveLabel, validMovesFor } from '../engine/analysisGame';
import { DEFAULT_ANALYSIS_PRESET } from '../engine/gameAnalysis';
import { ReviewError, reviewSourceFromPGN, winPercent } from '../engine/gameReview';
import { formatMove } from '../engine/pgn';
import { REVIEW_PRESETS, analyzePosition } from '../engine/rpsfishClient';
import useGameAnalysis from '../hooks/useGameAnalysis';
import useReplayKeyboard from '../hooks/useReplayKeyboard';
import { getGamePGN, putGameAccuracy } from '../store/reviewApi';
import { useGameStore } from '../store/gameStore';
import { colors, radius } from '../theme';

const samePosition = (first, second) => first?.x === second?.x && first?.y === second?.y;

// A stable empty line, so the analysis hook is not handed a new array on every
// render while the record is still loading.
const EMPTY_LINE = Object.freeze([]);

/**
 * What the grade means, in a sentence.
 *
 * A move can give up nothing and still not be the move the engine names, so
 * "best was X" is only said when something was actually lost by not playing
 * it.
 */
const moveVerdict = (move) => {
  if (move.grade?.key === 'great') {
    return `The only move at depth ${move.depth} that stayed within the Good threshold.`;
  }
  if (move.isTopMove) return `The engine's own choice at depth ${move.depth}.`;
  const best = move.bestMove ? moveLabel(move.bestMove) : 'unavailable';
  if (move.lossPercent < 0.05) return `As strong as the engine's ${best}.`;
  return `Best was ${best} · ${move.lossPercent.toFixed(1)} points of expected score given up.`;
};

function CurrentMoveCard({ analysis, engineState, move, onPlayBest }) {
  if (!move) {
    return (
      <View style={styles.currentCard}>
        <Text style={styles.cardEyebrow}>OPENING POSITION</Text>
        <Text style={styles.currentDetail}>
          Step forward with the right arrow key, or press a move in the list.
        </Text>
      </View>
    );
  }

  return (
    <View style={styles.currentCard}>
      <View style={styles.currentTop}>
        <View style={styles.currentCopy}>
          <Text style={styles.cardEyebrow}>
            MOVE {move.index + 1} · {move.player.toUpperCase()}
          </Text>
          <Text style={styles.currentMove}>{formatMove(move)}</Text>
        </View>
        {move.pending ? (
          <ActivityIndicator color={colors.textMuted} size="small" />
        ) : (
          <MoveQualityBadge grade={move.grade} />
        )}
      </View>
      {move.pending ? (
        <Text style={styles.currentDetail}>RPSFish has not reached this move yet.</Text>
      ) : (
        <Text style={styles.currentDetail}>{moveVerdict(move)}</Text>
      )}
      {!move.pending && !move.isTopMove && move.bestMove ? (
        <Pressable
          accessibilityRole="button"
          onPress={() => onPlayBest(move.bestMove)}
          style={({ pressed }) => [styles.tryButton, pressed && styles.pressed]}
        >
          <Text style={styles.tryButtonText}>Play the engine move instead</Text>
        </Pressable>
      ) : null}
      {engineState === 'thinking' && !analysis ? (
        <Text style={styles.currentDetail}>Analysing this position…</Text>
      ) : null}
    </View>
  );
}

export default function ReviewScreen({ navigation, route }) {
  const { height, width } = useWindowDimensions();
  const { gameId, pgn: providedPGN, playerColor } = route.params ?? {};
  const modes = useGameStore((state) => state.modes);
  const accountId = useGameStore((state) => state.accountId);
  const profileKey = useGameStore((state) => state.profileKey);

  // Chat is a property of the live session, not of the review: staying on the
  // same finished game means the room the players are already in stays open
  // while they look at the board together.
  const liveGameId = useGameStore((state) => state.gameState?.gameId ?? null);
  const chatMessages = useGameStore((state) => state.chatMessages);
  const chatVisible = useGameStore((state) => state.chatVisible);
  const showSpectatorMessages = useGameStore((state) => state.showSpectatorMessages);
  const isSpectating = useGameStore((state) => state.isSpectating);
  const connectionStatus = useGameStore((state) => state.connectionStatus);
  const sendChat = useGameStore((state) => state.sendChat);
  const toggleChat = useGameStore((state) => state.toggleChat);
  const toggleSpectatorMessages = useGameStore((state) => state.toggleSpectatorMessages);

  const [pgnText, setPgnText] = useState(providedPGN ?? null);
  const [loadError, setLoadError] = useState(null);
  const [preset, setPreset] = useState(DEFAULT_ANALYSIS_PRESET);
  const [cursor, setCursor] = useState(0);
  const [branch, setBranch] = useState(null);
  const [selectedTile, setSelectedTile] = useState(null);
  const [validMoves, setValidMoves] = useState([]);
  const [branchAnalysis, setBranchAnalysis] = useState(null);
  const [branchState, setBranchState] = useState('idle');
  const [copyState, setCopyState] = useState('idle');
  const [widePanelHeight, setWidePanelHeight] = useState(null);
  const savedRef = useRef(null);

  useEffect(() => {
    if (pgnText || !gameId) return undefined;
    let cancelled = false;
    getGamePGN(gameId)
      .then((text) => {
        if (!cancelled) setPgnText(text);
      })
      .catch((error) => {
        if (!cancelled) setLoadError(error.message);
      });
    return () => {
      cancelled = true;
    };
  }, [gameId, pgnText]);

  const source = useMemo(() => {
    if (!pgnText) return null;
    try {
      return reviewSourceFromPGN(pgnText, modes);
    } catch (error) {
      if (error instanceof ReviewError || error?.name === 'PGNError') return { error: error.message };
      throw error;
    }
  }, [modes, pgnText]);
  const sourceError = source?.error ?? null;
  const record = sourceError ? null : source;

  // The review itself. `useGameAnalysis` is the same walk the bot battle and
  // the analysis board run; a record arrives whole, so it is handed over once
  // and graded in one pass.
  const gameAnalysis = useGameAnalysis({
    bookPlies: record?.bookPlies ?? 0,
    mode: record?.mode,
    moves: record?.moves ?? EMPTY_LINE,
    positions: record?.positions ?? EMPTY_LINE,
    preset,
  });
  const entries = gameAnalysis.entries;
  const report = gameAnalysis.report;
  const reviewState = gameAnalysis.status;

  useEffect(() => {
    if (gameAnalysis.error) setLoadError(gameAnalysis.error);
  }, [gameAnalysis.error]);

  // What the board is showing: the record's line, or the line the reviewer is
  // playing themselves once they leave it.
  const positionsInView = useMemo(() => {
    if (!record) return [];
    if (!branch) return record.positions;
    return [...record.positions.slice(0, branch.baseIndex + 1), ...branch.positions];
  }, [branch, record]);

  const game = positionsInView[Math.min(cursor, Math.max(0, positionsInView.length - 1))] ?? null;
  const onMainLine = !branch || cursor <= branch.baseIndex;
  const mainLineIndex = branch ? Math.min(cursor, branch.baseIndex) : cursor;

  const analysis = onMainLine ? entries[cursor]?.analysis ?? null : branchAnalysis;

  // A position off the record was never graded, so it is analysed on demand.
  // Pre-emptive, and safely so: the review has a worker of its own, so
  // abandoning this search for the next branch position cannot touch it.
  useEffect(() => {
    if (!game || onMainLine) {
      setBranchAnalysis(null);
      setBranchState('idle');
      return undefined;
    }
    const controller = new AbortController();
    setBranchAnalysis(null);
    setBranchState('thinking');
    analyzePosition(
      {
        ...enginePosition(game),
        history: positionsInView.slice(0, cursor).map(enginePosition),
      },
      { ...REVIEW_PRESETS[preset], variations: 3, signal: controller.signal },
      (update) => setBranchAnalysis((current) => (current && current.depth > update.depth ? current : update)),
    )
      .then((result) => {
        setBranchAnalysis((current) => (current && current.depth > result.depth ? current : result));
        setBranchState('ready');
      })
      .catch((error) => {
        if (error?.name === 'AbortError') return;
        setBranchState('error');
      });
    return () => controller.abort();
  }, [cursor, game, onMainLine, positionsInView, preset]);

  const clearSelection = useCallback(() => {
    setSelectedTile(null);
    setValidMoves([]);
  }, []);

  const goTo = useCallback(
    (index) => {
      clearSelection();
      setBranch(null);
      setCursor(Math.max(0, Math.min(index, (record?.positions.length ?? 1) - 1)));
    },
    [clearSelection, record],
  );

  const stepForward = useCallback(() => {
    clearSelection();
    setCursor((current) => Math.min(current + 1, positionsInView.length - 1));
  }, [clearSelection, positionsInView.length]);

  // Stepping back out of a deviation drops it, so the record is always what
  // stepping forward follows. That is the point of a main line: your own idea
  // is a detour, and leaving it puts you back on the game that was played.
  const stepBack = useCallback(() => {
    clearSelection();
    setCursor((current) => {
      const next = Math.max(0, current - 1);
      if (branch && next <= branch.baseIndex) setBranch(null);
      return next;
    });
  }, [branch, clearSelection]);

  // Take back one move of the record and play the engine's instead.
  //
  // The move being graded led *into* the position on screen, so trying the
  // alternative means going back a step first. Doing it in one action keeps
  // that from being the reviewer's problem.
  const playInstead = useCallback(
    (moveIndex, best) => {
      const base = moveIndex;
      const from = record?.positions[base];
      if (!from) return;
      const result = applyAnalysisMove(from, best.from, best.to);
      if (!result) return;
      clearSelection();
      setBranch({
        baseIndex: base,
        positions: [result.game],
        moves: [
          {
            from: best.from,
            to: best.to,
            player: result.mover,
            piece: from.grid[best.from.y][best.from.x].occupant,
            captured: from.grid[best.to.y][best.to.x].occupant,
          },
        ],
      });
      setCursor(base + 1);
    },
    [clearSelection, record],
  );

  const playMove = useCallback(
    (from, to) => {
      if (!game || game.status !== 'InProgress') return;
      const result = applyAnalysisMove(game, from, to);
      if (!result) return;
      clearSelection();

      // Replaying the game by hand should not count as leaving it.
      const recorded = onMainLine ? record.moves[cursor] : null;
      if (recorded && samePosition(recorded.from, from) && samePosition(recorded.to, to)) {
        setCursor(cursor + 1);
        return;
      }

      const baseIndex = branch ? branch.baseIndex : cursor;
      const offset = cursor - baseIndex;
      setBranch({
        baseIndex,
        positions: [...(branch?.positions ?? []).slice(0, offset), result.game],
        moves: [
          ...(branch?.moves ?? []).slice(0, offset),
          { from, to, player: result.mover, piece: game.grid[from.y][from.x].occupant, captured: game.grid[to.y][to.x].occupant },
        ],
      });
      setCursor(cursor + 1);
    },
    [branch, clearSelection, cursor, game, onMainLine, record],
  );

  const selectTile = useCallback(
    (position) => {
      if (!game || game.status !== 'InProgress') return;
      if (selectedTile && validMoves.some((move) => samePosition(move, position))) {
        playMove(selectedTile, position);
        return;
      }
      if (selectedTile && samePosition(selectedTile, position)) {
        clearSelection();
        return;
      }
      const moves = validMovesFor(game, position);
      setSelectedTile(moves.length ? position : null);
      setValidMoves(moves);
    },
    [clearSelection, game, playMove, selectedTile, validMoves],
  );

  const goToFirst = useCallback(() => goTo(0), [goTo]);
  const goToLast = useCallback(
    () => goTo((record?.positions.length ?? 1) - 1),
    [goTo, record],
  );
  useReplayKeyboard({
    onFirst: goToFirst,
    onLast: goToLast,
    onNext: stepForward,
    onPrevious: stepBack,
  });

  // Store the accuracy once, and only once the whole game has been graded:
  // an average over the moves reviewed so far is not anybody's accuracy.
  useEffect(() => {
    const viewerColor = record
      ? ['Red', 'Blue'].find((color) => record.players[color]?.userId === accountId)
      : null;
    if (!record || !report?.complete || !gameId || !viewerColor) return;
    const measured = report.accuracy[viewerColor];
    if (!measured) return;
    const key = `${gameId}:${viewerColor}:${preset}`;
    if (savedRef.current === key) return;
    savedRef.current = key;
    putGameAccuracy(gameId, profileKey, {
      color: viewerColor,
      accuracy: measured.accuracy,
      averageLossPercent: measured.averageLossPercent,
      averageLossCentipawns: measured.averageLossCentipawns,
      moveCount: measured.moveCount,
      // The server predates the Great classification. It stores Great moves
      // with Best so the persisted grade total remains equal to moveCount.
      grades: {
        ...measured.grades,
        best: measured.grades.best + measured.grades.great,
        great: undefined,
      },
      engine: {
        preset,
        maxDepth: REVIEW_PRESETS[preset].maxDepth,
        maxNodes: REVIEW_PRESETS[preset].maxNodes,
        maxTimeMs: REVIEW_PRESETS[preset].maxTimeMs,
        variations: REVIEW_PRESETS[preset].variations,
      },
    })
      .then(() => {})
      .catch((error) => {});
  }, [accountId, gameId, preset, profileKey, record, report]);

  const isWide = width >= 900 && width > height;
  // Chat lives under the board on a wide screen, so the board leaves room for
  // it rather than pushing it off the bottom.
  const showChat = Boolean(liveGameId) && liveGameId === gameId;
  const boardAllowance = isWide ? 112 + (showChat ? 240 : 0) : 0;
  const boardSize = Math.floor(
    Math.max(
      230,
      Math.min(
        620,
        isWide ? width - 440 : width - 58,
        isWide ? height - boardAllowance : height * 0.5,
      ),
    ),
  );

  if (loadError && !record) {
    return (
      <SafeAreaView style={styles.safeArea} edges={['top', 'right', 'bottom', 'left']}>
        <View style={styles.centered}>
          <Text style={styles.emptyTitle}>This game cannot be reviewed</Text>
          <Text style={styles.emptyBody}>{loadError}</Text>
          <Pressable
            accessibilityRole="button"
            onPress={() => navigation.goBack()}
            style={({ pressed }) => [styles.emptyButton, pressed && styles.pressed]}
          >
            <Text style={styles.emptyButtonText}>Go back</Text>
          </Pressable>
        </View>
      </SafeAreaView>
    );
  }

  if (sourceError) {
    return (
      <SafeAreaView style={styles.safeArea} edges={['top', 'right', 'bottom', 'left']}>
        <View style={styles.centered}>
          <Text style={styles.emptyTitle}>This record could not be replayed</Text>
          <Text style={styles.emptyBody}>{sourceError}</Text>
          <Pressable
            accessibilityRole="button"
            onPress={() => navigation.goBack()}
            style={({ pressed }) => [styles.emptyButton, pressed && styles.pressed]}
          >
            <Text style={styles.emptyButtonText}>Go back</Text>
          </Pressable>
        </View>
      </SafeAreaView>
    );
  }

  if (!record || !game) {
    return (
      <SafeAreaView style={styles.safeArea} edges={['top', 'right', 'bottom', 'left']}>
        <View style={styles.centered}>
          <ActivityIndicator color={colors.accent} size="large" />
          <Text style={styles.emptyBody}>Loading the game record…</Text>
        </View>
      </SafeAreaView>
    );
  }

  const viewerColor =
    playerColor && playerColor !== 'Neutral'
      ? playerColor
      : ['Red', 'Blue'].find((color) => record.players[color]?.userId === accountId) ?? null;
  const currentMove = mainLineIndex > 0 ? report.moves[mainLineIndex - 1] : null;
  const lastMoveShown =
    cursor > 0
      ? branch && cursor > branch.baseIndex
        ? branch.moves[cursor - branch.baseIndex - 1]
        : record.moves[cursor - 1]
      : null;
  const chartPoints = report.evaluations.map((point) => ({
    index: point.index,
    redPercent: winPercent(point.redScore, record.mode.id),
  }));
  const progress = Math.round((report.analyzed / Math.max(1, report.total)) * 100);
  const chat = showChat ? (
    <GameChat
      accountId={accountId}
      chatVisible={chatVisible}
      connected={connectionStatus === 'connected'}
      gameStatus="Finished"
      isSpectating={isSpectating}
      messages={chatMessages}
      onSend={sendChat}
      onToggleChat={toggleChat}
      onToggleSpectatorMessages={toggleSpectatorMessages}
      showSpectatorMessages={showSpectatorMessages}
      spectatorCount={0}
      wide={false}
    />
  ) : null;

  const boardBlock = (
    <View style={styles.boardWithEval}>
      <EvalBar height={boardSize} redScore={analysis?.redScore} />
      <Board
        analysisArrows={analysis?.lines ?? []}
        boardSize={boardSize}
        canMove={game.status === 'InProgress'}
        grid={game.grid}
        lastMove={lastMoveShown ? { from: lastMoveShown.from, to: lastMoveShown.to } : null}
        lastMoveGrade={onMainLine && !currentMove?.pending ? currentMove?.grade : null}
        modeId={record.mode.id}
        movableColor={game.currentTurn}
        onPieceDrop={playMove}
        onTilePress={selectTile}
        playerColor={viewerColor === 'Blue' ? 'Blue' : 'Red'}
        replayIndex={cursor}
        replayPositions={positionsInView}
        selectedTile={selectedTile}
        validMoves={validMoves}
      />
    </View>
  );

  const controls = (
    <ReplayControls
      current={cursor}
      label={branch && cursor > branch.baseIndex ? 'YOUR LINE' : 'MOVE'}
      onFirst={goToFirst}
      onLast={goToLast}
      onNext={stepForward}
      onPrevious={stepBack}
      total={positionsInView.length - 1}
    />
  );

  const panel = (
    <View style={styles.panelStack}>
      {branch && cursor > branch.baseIndex ? (
        <View style={styles.branchNotice}>
          <Text style={styles.branchText}>
            You are off the game, {cursor - branch.baseIndex} move
            {cursor - branch.baseIndex === 1 ? '' : 's'} into your own line.
            {branchState === 'thinking' ? ' RPSFish is looking at it…' : ''}
          </Text>
          <Pressable
            accessibilityRole="button"
            onPress={() => goTo(branch.baseIndex)}
            style={({ pressed }) => [styles.branchButton, pressed && styles.pressed]}
          >
            <Text style={styles.branchButtonText}>Back to the game</Text>
          </Pressable>
        </View>
      ) : null}

      <View style={styles.recordCard}>
        <View style={styles.recordCopy}>
          <Text style={styles.cardEyebrow}>GAME RECORD</Text>
          <Text accessibilityLiveRegion="polite" style={styles.recordDetail}>
            {copyState === 'copied'
              ? 'PGN copied to your clipboard.'
              : copyState === 'error'
                ? 'The PGN could not be copied.'
                : 'Copy this game to save it or analyze it again later.'}
          </Text>
        </View>
        <Pressable
          accessibilityLabel="Copy game PGN"
          accessibilityRole="button"
          onPress={async () => {
            try {
              await Clipboard.setStringAsync(record.pgn);
              setCopyState('copied');
            } catch (error) {
              setCopyState('error');
            }
          }}
          style={({ pressed }) => [styles.copyButton, pressed && styles.pressed]}
        >
          <Text style={styles.copyButtonText}>
            {copyState === 'copied' ? 'COPIED ✓' : 'COPY PGN'}
          </Text>
        </Pressable>
      </View>

      <AccuracyCard
        accuracy={report.accuracy}
        pendingDetail={
          gameAnalysis.error ? 'The review stopped before it could finish.' : 'Still reviewing…'
        }
        players={record.players}
        viewerColor={viewerColor}
      />

      {isWide ? null : chat}

      <EvalChart
        currentIndex={mainLineIndex}
        moves={report.moves}
        onSelect={goTo}
        points={chartPoints}
        total={record.positions.length}
      />

      {record.mode.features?.includes('territory') ? <TerritoryMeter grid={game.grid} /> : null}

      {onMainLine ? (
        <CurrentMoveCard
          analysis={analysis}
          engineState={reviewState}
          move={currentMove}
          onPlayBest={(best) => playInstead(mainLineIndex - 1, best)}
        />
      ) : null}

      <EngineLinesCard analysis={analysis} turn={game.currentTurn} />

      <MoveAnalysisList moves={report.moves} onSelect={goTo} selectedIndex={mainLineIndex} />
    </View>
  );

  return (
    <SafeAreaView style={styles.safeArea} edges={['top', 'right', 'bottom', 'left']}>
      <View style={styles.screen}>
        <View style={styles.topBar}>
          <Pressable
            accessibilityLabel="Leave the review"
            accessibilityRole="button"
            onPress={() => navigation.goBack()}
            style={({ pressed }) => [styles.backButton, pressed && styles.pressed]}
          >
            <Text style={styles.backIcon}>‹</Text>
          </Pressable>
          <View style={styles.titleCopy}>
            <Text numberOfLines={1} style={styles.kicker}>
              {record.mode.shortCode ?? record.mode.id} · GAME REVIEW ·{' '}
              {reviewState === 'running' ? `${progress}%` : record.result}
            </Text>
            <Text numberOfLines={1} style={styles.title}>
              {record.players.Red?.name || 'Red'} vs {record.players.Blue?.name || 'Blue'}
            </Text>
          </View>
          <AnalysisPresetPicker onChange={setPreset} value={preset} />
        </View>

        {isWide ? (
          <View
            onLayout={(event) => {
              const nextHeight = Math.floor(event.nativeEvent.layout.height);
              setWidePanelHeight((current) => (current === nextHeight ? current : nextHeight));
            }}
            style={styles.wideLayout}
          >
            <View style={[styles.boardColumn, { width: boardSize + 38 }]}>
              {boardBlock}
              {controls}
              {chat}
            </View>
            <ScrollView
              contentContainerStyle={styles.widePanelContent}
              keyboardShouldPersistTaps="handled"
              showsVerticalScrollIndicator={false}
              style={[
                styles.widePanel,
                { maxHeight: widePanelHeight ?? boardSize },
              ]}
            >
              {panel}
            </ScrollView>
          </View>
        ) : (
          <ScrollView
            contentContainerStyle={styles.mobileContent}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
          >
            {boardBlock}
            {controls}
            {panel}
          </ScrollView>
        )}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: colors.background },
  screen: {
    flex: 1,
    width: '100%',
    maxWidth: 1240,
    alignSelf: 'center',
    paddingHorizontal: 12,
    paddingBottom: 10,
  },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12, padding: 24 },
  emptyTitle: { color: colors.textStrong, fontSize: 22, fontWeight: '900', textAlign: 'center' },
  emptyBody: { color: colors.textMuted, fontSize: 12, textAlign: 'center' },
  emptyButton: {
    marginTop: 10,
    paddingHorizontal: 18,
    paddingVertical: 11,
    borderRadius: radius.medium,
    backgroundColor: colors.accent,
  },
  emptyButtonText: { color: colors.textStrong, fontWeight: '900' },
  pressed: { opacity: 0.68 },
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
  title: { color: colors.textStrong, fontSize: 18, fontWeight: '900', marginTop: 2 },
  wideLayout: { flex: 1, flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'center', gap: 18 },
  boardColumn: { alignItems: 'center', gap: 10 },
  boardWithEval: { flexDirection: 'row', alignItems: 'stretch', gap: 7 },
  widePanel: { width: 360 },
  widePanelContent: { paddingBottom: 18 },
  mobileContent: { alignItems: 'center', paddingBottom: 24, gap: 12 },
  panelStack: { width: '100%', gap: 10 },
  recordCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: 13,
    borderRadius: 11,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  recordCopy: { flex: 1, minWidth: 0 },
  recordDetail: { color: colors.textMuted, fontSize: 9, lineHeight: 14, marginTop: 4 },
  copyButton: {
    minHeight: 36,
    justifyContent: 'center',
    paddingHorizontal: 12,
    borderRadius: radius.small,
    borderWidth: 1,
    borderColor: colors.accent,
    backgroundColor: colors.accentSurfaceRaised,
  },
  copyButtonText: { color: colors.accentSoft, fontSize: 8, fontWeight: '900' },
  branchNotice: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    padding: 11,
    borderRadius: radius.medium,
    borderWidth: 1,
    borderColor: colors.accentBorder,
    backgroundColor: colors.accentSurface,
  },
  branchText: { flex: 1, color: colors.accentSoft, fontSize: 9, lineHeight: 14 },
  branchButton: {
    paddingHorizontal: 10,
    paddingVertical: 7,
    borderRadius: radius.small,
    backgroundColor: colors.accent,
  },
  branchButtonText: { color: colors.textStrong, fontSize: 8, fontWeight: '900' },
  cardEyebrow: { color: colors.textFaint, fontSize: 8, fontWeight: '900', letterSpacing: 1.2 },
  saveNotice: { color: colors.textFaint, fontSize: 8, marginTop: 10 },
  currentCard: {
    padding: 13,
    borderRadius: 11,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  currentTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
  currentCopy: { flex: 1, minWidth: 0 },
  currentMove: { color: colors.textStrong, fontSize: 17, fontWeight: '900', marginTop: 4 },
  currentDetail: { color: colors.textMuted, fontSize: 9, lineHeight: 14, marginTop: 8 },
  tryButton: {
    alignSelf: 'flex-start',
    marginTop: 10,
    paddingHorizontal: 11,
    paddingVertical: 8,
    borderRadius: radius.small,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    backgroundColor: colors.surfaceRaised,
  },
  tryButtonText: { color: colors.textSoft, fontSize: 9, fontWeight: '900' },
});
