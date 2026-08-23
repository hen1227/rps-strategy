import * as Clipboard from 'expo-clipboard';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { applyAnalysisMove, moveLabel, type AnalysisGame } from '@/engine/analysisGame';
import { DEFAULT_ANALYSIS_PRESET, type AnalysisPreset } from '@/engine/gameAnalysis';
import {
  ReviewError,
  expectedScoreCurve,
  reviewSourceFromPGN,
  type GradedMove,
  type RecordedMove,
  type ReviewMove,
  type ReviewSource,
} from '@/engine/gameReview';
import { PGNError, formatMove } from '@/engine/pgn';
import { REVIEW_PRESETS } from '@/engine/rpsfish/client';
import type { Analysis } from '@/engine/rpsfish/protocol';
import AccuracyCard from '@/features/analysis/AccuracyCard';
import AnalysisPresetPicker from '@/features/analysis/AnalysisPresetPicker';
import EngineLinesCard from '@/features/analysis/EngineLinesCard';
import EvalBar from '@/features/analysis/EvalBar';
import EvalChart from '@/features/analysis/EvalChart';
import MoveAnalysisList from '@/features/analysis/MoveAnalysisList';
import MoveQualityBadge from '@/features/analysis/MoveQualityBadge';
import ReplayControls from '@/features/analysis/ReplayControls';
import TerritoryMeter from '@/features/analysis/TerritoryMeter';
import Board from '@/features/board/Board';
import GameChat from '@/features/game/GameChat';
import { failureMessage } from '@/errors';
import { useBoardLayout } from '@/hooks/useBoardLayout';
import { useBoardSelection } from '@/hooks/useBoardSelection';
import useGameAnalysis from '@/hooks/useGameAnalysis';
import { usePositionAnalysis } from '@/hooks/usePositionAnalysis';
import useReplayKeyboard from '@/hooks/useReplayKeyboard';
import { useReplayCursor } from '@/hooks/useReplayCursor';
import { links } from '@/navigation/links';
import { getGamePGN, putGameAccuracy } from '@/store/api/review';
import { roomSpansSeries } from '@/store/chatSelectors';
import { useGameStore } from '@/store/gameStore';
import { useReviewHandoff } from '@/store/reviewHandoff';
import { colors, radius } from '@/theme';
import {
  SIDE_COLORS,
  sameMove,
  type Move,
  type Position,
  type SideColor,
} from '@/types/game';

// A stable empty line, so the analysis hook is not handed a new array on every
// render while the record is still loading.
const EMPTY_POSITIONS: AnalysisGame[] = [];
const EMPTY_MOVES: RecordedMove[] = [];

/**
 * A line the reviewer played themselves, off the record.
 *
 * `baseIndex` is the position of the record it left from, so the board can show
 * the record up to there and this line after it.
 */
interface ReviewBranch {
  baseIndex: number;
  positions: AnalysisGame[];
  moves: RecordedMove[];
}

/**
 * Play a move into a branch: the position it reaches, and the move in the shape
 * the review's own move list uses.
 *
 * A branch move has no clock, because nobody was on one — this line was never
 * played in the game.
 */
const branchMove = (
  game: AnalysisGame,
  from: Position,
  to: Position,
): { game: AnalysisGame; move: RecordedMove } | null => {
  const source = game.grid[from.y]?.[from.x];
  const destination = game.grid[to.y]?.[to.x];
  if (!source || !destination || source.occupant === 'Empty') return null;
  const result = applyAnalysisMove(game, from, to);
  if (!result) return null;
  return {
    game: result.game,
    move: {
      from,
      to,
      player: result.mover,
      piece: source.occupant,
      captured: destination.occupant,
      elapsedMs: null,
      redRemainingMs: null,
      blueRemainingMs: null,
    },
  };
};

/**
 * What the grade means, in a sentence.
 *
 * A move can give up nothing and still not be the move the engine names, so
 * "best was X" is only said when something was actually lost by not playing
 * it.
 */
const moveVerdict = (move: GradedMove) => {
  if (move.grade.key === 'great') {
    return `The only move at depth ${move.depth} that stayed within the Good threshold.`;
  }
  if (move.isTopMove) return `The engine's own choice at depth ${move.depth}.`;
  const best = move.bestMove ? moveLabel(move.bestMove) : 'unavailable';
  if (move.lossPercent < 0.05) return `As strong as the engine's ${best}.`;
  return `Best was ${best} · ${move.lossPercent.toFixed(1)} points of expected score given up.`;
};

interface CurrentMoveCardProps {
  analysis: Analysis | null;
  /**
   * Whether the engine is still working on this position. A boolean rather
   * than a status, because the card is fed by two different vocabularies —
   * the review walk's and a single search's.
   */
  thinking: boolean;
  /** The move that led into the position on screen, or null at the opening. */
  move: ReviewMove | null;
  /** Take that move back and play the engine's instead. */
  onPlayBest: (best: Move) => void;
}

function CurrentMoveCard({ analysis, move, onPlayBest, thinking }: CurrentMoveCardProps) {
  // Offered only when there was something better: a move that gave up nothing
  // has no alternative worth trying.
  const bestMove = move && !move.pending && !move.isTopMove ? move.bestMove : null;
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
      {bestMove ? (
        <Pressable
          accessibilityRole="button"
          onPress={() => onPlayBest(bestMove)}
          style={({ pressed }) => [styles.tryButton, pressed && styles.pressed]}
        >
          <Text style={styles.tryButtonText}>Play the engine move instead</Text>
        </Pressable>
      ) : null}
      {thinking && !analysis ? (
        <Text style={styles.currentDetail}>Analysing this position…</Text>
      ) : null}
    </View>
  );
}

export default function ReviewScreen() {
  const router = useRouter();
  // A stored game is addressed by id, so `/review?gameId=…` is shareable. A bot
  // game or a pasted record has no id and arrives through the handoff store,
  // because a PGN does not belong in a URL.
  const { gameId } = useLocalSearchParams<{ gameId?: string }>();
  const takeHandoff = useReviewHandoff((state) => state.take);
  const [handoff] = useState(() => (gameId ? null : takeHandoff()));
  const providedPGN = handoff?.pgn ?? null;
  const playerColor = handoff?.playerColor ?? null;
  const modes = useGameStore((state) => state.modes);
  const accountId = useGameStore((state) => state.accountId);
  const profileKey = useGameStore((state) => state.profileKey);

  // Chat is a property of the live session, not of the review: staying on the
  // same finished game means the room the players are already in stays open
  // while they look at the board together.
  const liveGameId = useGameStore((state) => state.gameState?.gameId ?? null);
  const chatMessages = useGameStore((state) => state.chatMessages);
  const chatRoomId = useGameStore((state) => state.chatRoomId);
  const chatVisible = useGameStore((state) => state.chatVisible);
  const showSpectatorMessages = useGameStore((state) => state.showSpectatorMessages);
  const isSpectating = useGameStore((state) => state.isSpectating);
  const connectionStatus = useGameStore((state) => state.connectionStatus);
  const sendChat = useGameStore((state) => state.sendChat);
  const toggleChat = useGameStore((state) => state.toggleChat);
  const toggleSpectatorMessages = useGameStore((state) => state.toggleSpectatorMessages);

  const [pgnText, setPgnText] = useState<string | null>(providedPGN);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [preset, setPreset] = useState<AnalysisPreset>(DEFAULT_ANALYSIS_PRESET);
  const [branch, setBranch] = useState<ReviewBranch | null>(null);
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'error'>('idle');
  const [widePanelHeight, setWidePanelHeight] = useState<number | null>(null);
  // The key of the accuracy already reported, so it is reported once.
  const savedRef = useRef<string | null>(null);

  useEffect(() => {
    if (pgnText || !gameId) return undefined;
    let cancelled = false;
    getGamePGN(gameId)
      .then((text) => {
        if (!cancelled) setPgnText(text);
      })
      .catch((error: unknown) => {
        if (!cancelled) setLoadError(failureMessage(error, 'The record could not be loaded.'));
      });
    return () => {
      cancelled = true;
    };
  }, [gameId, pgnText]);

  // A record that cannot be read is shown as a message rather than thrown:
  // the reviewer pasted it, and telling them what is wrong with it is the
  // useful thing to do. Anything else is a bug and is left to escape.
  const source = useMemo((): { record: ReviewSource } | { error: string } | null => {
    if (!pgnText) return null;
    try {
      return { record: reviewSourceFromPGN(pgnText, modes) };
    } catch (error) {
      if (error instanceof ReviewError || error instanceof PGNError) {
        return { error: error.message };
      }
      throw error;
    }
  }, [modes, pgnText]);
  const sourceError = source && 'error' in source ? source.error : null;
  const record = source && 'record' in source ? source.record : null;

  // The review itself. `useGameAnalysis` is the same walk the bot battle and
  // the analysis board run; a record arrives whole, so it is handed over once
  // and graded in one pass.
  const gameAnalysis = useGameAnalysis({
    bookPlies: record?.bookPlies ?? 0,
    mode: record?.mode,
    moves: record?.moves ?? EMPTY_MOVES,
    positions: record?.positions ?? EMPTY_POSITIONS,
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

  // Where along the line the reviewer is standing. The same hook the bot
  // battle uses, so both boards clamp and step identically.
  const replay = useReplayCursor({
    length: positionsInView.length,
    keyboard: false,
  });
  const cursor = replay.cursor;

  const game = positionsInView[Math.min(cursor, Math.max(0, positionsInView.length - 1))] ?? null;
  const onMainLine = !branch || cursor <= branch.baseIndex;
  const mainLineIndex = branch ? Math.min(cursor, branch.baseIndex) : cursor;

  // A position off the record was never graded, so it is analysed on demand —
  // by the same hook the analysis board's own search uses. Safe to run
  // pre-emptively: the review has a worker of its own, so abandoning this
  // search for the next branch position cannot touch the walk.
  const branchHistory = useMemo(() => positionsInView.slice(0, cursor), [cursor, positionsInView]);
  const branchSearch = usePositionAnalysis({
    position: game,
    history: branchHistory,
    limits: { ...REVIEW_PRESETS[preset], variations: 3 },
    enabled: !onMainLine,
  });
  const branchAnalysis = branchSearch.analysis;
  const branchState = branchSearch.status;

  const analysis = onMainLine ? entries[cursor]?.analysis ?? null : branchAnalysis;

  const playMove = useCallback(
    (from: Position, to: Position) => {
      if (!game) return;
      const played = branchMove(game, from, to);
      if (!played) return;

      // Replaying the game by hand should not count as leaving it.
      const recorded = onMainLine ? record?.moves[cursor] : null;
      if (recorded && sameMove(recorded, { from, to })) {
        replay.stepForward();
        return;
      }

      const baseIndex = branch ? branch.baseIndex : cursor;
      const offset = cursor - baseIndex;
      setBranch({
        baseIndex,
        positions: [...(branch?.positions ?? []).slice(0, offset), played.game],
        moves: [...(branch?.moves ?? []).slice(0, offset), played.move],
      });
      replay.goTo(cursor + 1);
    },
    [branch, cursor, game, onMainLine, record, replay],
  );

  const selection = useBoardSelection({ game, onMove: playMove });
  const { clearSelection, selectedTile, validMoves } = selection;

  const goTo = useCallback(
    (index: number) => {
      clearSelection();
      setBranch(null);
      replay.goTo(Math.min(index, (record?.positions.length ?? 1) - 1));
    },
    [clearSelection, record, replay],
  );

  const stepForward = useCallback(() => {
    clearSelection();
    replay.stepForward();
  }, [clearSelection, replay]);

  // Stepping back out of a deviation drops it, so the record is always what
  // stepping forward follows. That is the point of a main line: your own idea
  // is a detour, and leaving it puts you back on the game that was played.
  const stepBack = useCallback(() => {
    clearSelection();
    if (branch && cursor - 1 <= branch.baseIndex) setBranch(null);
    replay.stepBack();
  }, [branch, clearSelection, cursor, replay]);

  // Take back one move of the record and play the engine's instead.
  //
  // The move being graded led *into* the position on screen, so trying the
  // alternative means going back a step first. Doing it in one action keeps
  // that from being the reviewer's problem.
  const playInstead = useCallback(
    (moveIndex: number, best: Move) => {
      const from = record?.positions[moveIndex];
      if (!from) return;
      const played = branchMove(from, best.from, best.to);
      if (!played) return;
      clearSelection();
      setBranch({ baseIndex: moveIndex, positions: [played.game], moves: [played.move] });
      replay.goTo(moveIndex + 1);
    },
    [clearSelection, record, replay],
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
    const viewerColor: SideColor | null = record
      ? (SIDE_COLORS.find((color) => record.players[color]?.userId === accountId) ?? null)
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
      // A review the archive would not take is not worth interrupting the
      // reviewer over: the numbers on screen are the same either way.
      .catch(() => {});
  }, [accountId, gameId, preset, profileKey, record, report]);

  // Chat lives under the board on a wide screen, so the board leaves room for
  // it rather than pushing it off the bottom.
  const showChat = Boolean(liveGameId) && liveGameId === gameId;
  const { boardSize, isWide } = useBoardLayout({
    sidePanel: 440,
    below: showChat ? 240 : 0,
  });

  if (loadError && !record) {
    return (
      <SafeAreaView style={styles.safeArea} edges={['top', 'right', 'bottom', 'left']}>
        <View style={styles.centered}>
          <Text style={styles.emptyTitle}>This game cannot be reviewed</Text>
          <Text style={styles.emptyBody}>{loadError}</Text>
          <Pressable
            accessibilityRole="button"
            onPress={() => router.back()}
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
            onPress={() => router.back()}
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

  // Everything from here needs a report, which exists as soon as a record does.
  if (!report) return null;

  const viewerColor: SideColor | null =
    playerColor && playerColor !== 'Neutral'
      ? playerColor
      : (SIDE_COLORS.find((color) => record.players[color]?.userId === accountId) ?? null);
  const currentMove = mainLineIndex > 0 ? (report.moves[mainLineIndex - 1] ?? null) : null;
  const lastMoveShown =
    cursor > 0
      ? branch && cursor > branch.baseIndex
        ? branch.moves[cursor - branch.baseIndex - 1]
        : record.moves[cursor - 1]
      : null;
  const chartPoints = expectedScoreCurve(report.evaluations, record.mode.id);
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
      series={roomSpansSeries(chatRoomId, liveGameId)}
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
        onTilePress={selection.selectTile}
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
            } catch {
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
          thinking={reviewState === 'running'}
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
            onPress={() => router.back()}
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
