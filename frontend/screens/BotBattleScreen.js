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
import { capturedPieces } from '../components/CapturedPieces';
import EngineLinesCard from '../components/EngineLinesCard';
import EvalBar from '../components/EvalBar';
import EvalChart from '../components/EvalChart';
import MoveAnalysisList from '../components/MoveAnalysisList';
import MoveQualityBadge from '../components/MoveQualityBadge';
import PlayerBar from '../components/PlayerBar';
import ReplayControls from '../components/ReplayControls';
import TerritoryMeter from '../components/TerritoryMeter';
import { createAnalysisGame, moveLabel } from '../engine/analysisGame';
import { playBotGame } from '../engine/botArena';
import { createBot, createSeededRandom } from '../engine/botEngine';
import { botProfile } from '../engine/botProfiles';
import {
  ANALYSIS_PRESET_LABELS,
  WATCHED_GAME_PRESET,
} from '../engine/gameAnalysis';
import { winPercent } from '../engine/gameReview';
import { encodePGN, encodePosition, formatMove, resultFor } from '../engine/pgn';
import { REVIEW_PRESETS } from '../engine/rpsfishClient';
import useGameAnalysis from '../hooks/useGameAnalysis';
import useReplayKeyboard from '../hooks/useReplayKeyboard';
import { colors, players, radius } from '../theme';

const MIN_MOVE_TIME_MS = 250;

const botBattlePGN = ({
  blueProfile,
  endReason,
  mode,
  moves,
  redProfile,
  startGame,
  startedAtUnixMs,
  winner,
}) => {
  const result = resultFor('Finished', winner);
  return encodePGN({
    tags: [
      { name: 'Event', value: 'Bot battle' },
      { name: 'Site', value: 'RPS Strategy' },
      {
        name: 'Date',
        value: new Date(startedAtUnixMs).toISOString().slice(0, 10).replace(/-/g, '.'),
      },
      { name: 'Red', value: redProfile.name },
      { name: 'Blue', value: blueProfile.name },
      { name: 'Result', value: result },
      { name: 'Variant', value: mode.name },
      { name: 'ModeId', value: mode.id },
      { name: 'BoardSize', value: '9' },
      { name: 'SetUp', value: '1' },
      { name: 'FEN', value: encodePosition(startGame.grid, startGame.currentTurn) },
      { name: 'RedId', value: `bot:${redProfile.id}` },
      { name: 'BlueId', value: `bot:${blueProfile.id}` },
      { name: 'Ranked', value: 'false' },
      { name: 'EndReason', value: endReason },
      { name: 'StartTimeUnixMs', value: String(startedAtUnixMs) },
      { name: 'RedBotRating', value: String(redProfile.rating) },
      { name: 'BlueBotRating', value: String(blueProfile.rating) },
    ],
    moves,
    endReason,
    winner,
    result,
  });
};

const resultLabel = (winner, endReason) => {
  const result = winner === 'Neutral' ? 'Draw' : `${winner} wins`;
  const reason = {
    annihilation: 'annihilation',
    infiltration: 'infiltration',
    move_limit: 'move limit',
    repetition: 'threefold repetition',
    stalemate: 'stalemate',
    territory: 'territory',
  }[endReason];
  return reason ? `${result} by ${reason}` : result;
};

const plural = (count, noun) => `${count} ${noun}${count === 1 ? '' : 's'}`;

const ORDINAL_SUFFIXES = { 1: 'st', 2: 'nd', 3: 'rd' };
const ordinal = (value) => {
  if (typeof value !== 'number') return '—';
  const teen = value % 100 >= 11 && value % 100 <= 13;
  return `${value}${teen ? 'th' : ORDINAL_SUFFIXES[value % 10] ?? 'th'}`;
};

/**
 * What the bot did, and what the analysis makes of it.
 *
 * The two halves are deliberately separate. A bot's reason describes its own
 * shallow search — "the best move it found" is the best move *it* found — and
 * the grade describes the position. Running them together would let a weak
 * bot's confidence read as a verdict.
 */
const moveExplanation = (move, botName, analysis) => {
  if (!move) return 'Use the arrow keys or the controls below the board to inspect the match.';

  const chose =
    {
      best: `${botName} played the best move its own search found`,
      sampled: `${botName} sampled its ${ordinal(move.rank)} ranked candidate`,
      random: `${botName}'s difficulty profile called for a random legal move`,
      fallback: `${botName} fell back to a legal move after its search returned nothing`,
    }[move.reason] ?? `${botName} moved`;
  const bot = move.botDepth ? `${chose}, ${move.botDepth} plies deep.` : `${chose}.`;

  if (move.pending || !move.grade) {
    if (analysis.status === 'error') return `${bot} The analysis could not grade it.`;
    // Caught up and still ungraded means the engine returned no line for that
    // position — a terminal or repeated one — so there is nothing to measure
    // the move against rather than nothing measured yet.
    if (analysis.behind === 0) {
      return `${bot} RPSFish found no line to compare it with, so it is not graded.`;
    }
    return `${bot} The analysis has not reached it yet — it is ${plural(
      analysis.behind,
      'move',
    )} behind the board.`;
  }

  const best = move.bestMove ? moveLabel(move.bestMove) : 'unavailable';
  if (move.grade.key === 'great') {
    return `${bot} At depth ${move.depth} it was the only move that stayed within the Good threshold.`;
  }
  if (move.isTopMove) return `${bot} It is the analysis's own choice at depth ${move.depth}.`;
  if (move.lossPercent < 0.05) return `${bot} It scores as strongly as ${best}.`;
  return `${bot} Best was ${best}; the move gave up ${move.lossPercent.toFixed(
    1,
  )} points of expected score.`;
};

/** How far behind the board the analysis is, in a sentence. */
const analysisProgress = (analysis, preset, running) => {
  if (analysis.status === 'error') return analysis.error;
  const depth = REVIEW_PRESETS[preset]?.maxDepth;
  if (analysis.behind > 0) {
    return `Grading at ${ANALYSIS_PRESET_LABELS[preset]}, depth ${depth} — ${plural(
      analysis.behind,
      'move',
    )} behind the board. Every grade appears as it lands.`;
  }
  return running
    ? `Grading at ${ANALYSIS_PRESET_LABELS[preset]}, depth ${depth} — level with the board.`
    : `Every position graded at ${ANALYSIS_PRESET_LABELS[preset]}, depth ${depth}.`;
};

export default function BotBattleScreen({ navigation, route }) {
  const { height, width } = useWindowDimensions();
  const { mode, redProfileId, blueProfileId } = route.params ?? {};
  const redProfile = botProfile(redProfileId);
  const blueProfile = botProfile(blueProfileId);
  const initialGame = useMemo(() => (mode ? createAnalysisGame(mode) : null), [mode]);

  const [positions, setPositions] = useState(() => (initialGame ? [initialGame] : []));
  const [moves, setMoves] = useState([]);
  const [cursor, setCursor] = useState(0);
  const [matchState, setMatchState] = useState('running');
  const [matchError, setMatchError] = useState(null);
  const [result, setResult] = useState(null);
  const [pgn, setPgn] = useState(null);
  const [copyState, setCopyState] = useState('idle');
  const [preset, setPreset] = useState(WATCHED_GAME_PRESET);

  const positionsRef = useRef(initialGame ? [initialGame] : []);
  const movesRef = useRef([]);
  const cursorRef = useRef(0);
  const startedAtRef = useRef(Date.now());

  const updateCursor = useCallback((next) => {
    const maximum = Math.max(0, positionsRef.current.length - 1);
    const bounded = Math.max(0, Math.min(next, maximum));
    cursorRef.current = bounded;
    setCursor(bounded);
  }, []);

  const goToFirst = useCallback(() => updateCursor(0), [updateCursor]);
  const goToLast = useCallback(
    () => updateCursor(positionsRef.current.length - 1),
    [updateCursor],
  );
  const stepBack = useCallback(() => updateCursor(cursorRef.current - 1), [updateCursor]);
  const stepForward = useCallback(() => updateCursor(cursorRef.current + 1), [updateCursor]);

  useReplayKeyboard({
    onFirst: goToFirst,
    onLast: goToLast,
    onNext: stepForward,
    onPrevious: stepBack,
  });

  useEffect(() => {
    if (!mode || !initialGame) return undefined;
    const controller = new AbortController();
    const seed = Date.now() * 4096 + Math.floor(Math.random() * 4096);
    const openingPositions = [initialGame];

    positionsRef.current = openingPositions;
    movesRef.current = [];
    cursorRef.current = 0;
    setPositions(openingPositions);
    setMoves([]);
    setCursor(0);
    setMatchState('running');
    setMatchError(null);
    setResult(null);
    setPgn(null);
    setCopyState('idle');
    startedAtRef.current = Date.now();

    // Watched battles keep a short, consistent pacing floor so fast searches
    // remain readable. A search that takes longer than the floor is not delayed
    // further.
    //
    // Each bot searches only what its own profile allows, and nothing here
    // looks at what it found. A bot's search is how that bot chose its move —
    // two plies deep for the bottom rung, and a different depth on each side of
    // the board — so it says what the bot thought, not what was true. The
    // numbers on this screen come from the analysis pass instead.
    const buildBot = (profile, botSeed) =>
      createBot(
        {
          ...profile,
          tempo: { minThinkMs: MIN_MOVE_TIME_MS, maxThinkMs: MIN_MOVE_TIME_MS },
        },
        { random: createSeededRandom(botSeed) },
      );
    const redBot = buildBot(redProfile, seed + 1);
    const blueBot = buildBot(blueProfile, seed + 2);

    playBotGame({
      blueBot,
      mode,
      redBot,
      signal: controller.signal,
      onMove: ({ game, move, moveNumber }) => {
        if (controller.signal.aborted) return;
        const before = positionsRef.current[positionsRef.current.length - 1];
        movesRef.current.push({
          // What the bot did and why it did it. The grade for this move is not
          // here: it arrives from the analysis pass, which is behind the game.
          botDepth: move.analysis?.depth ?? null,
          captured: before.grid[move.to.y][move.to.x].occupant,
          elapsedMs: move.elapsedMs,
          from: move.from,
          piece: before.grid[move.from.y][move.from.x].occupant,
          player: move.mover,
          rank: move.rank,
          reason: move.reason,
          to: move.to,
        });

        const wasAtLiveEdge = cursorRef.current === positionsRef.current.length - 1;
        positionsRef.current.push(game);
        setMoves(movesRef.current.slice());
        setPositions(positionsRef.current.slice());
        if (wasAtLiveEdge) updateCursor(positionsRef.current.length - 1);
      },
    })
      .then((battleResult) => {
        if (controller.signal.aborted) return;
        const hitMoveLimit = battleResult.endReason === 'move_limit';
        const finalGame = hitMoveLimit
          ? {
              ...battleResult.finalGame,
              status: 'Finished',
              winner: 'Neutral',
              endReason: 'move_limit',
            }
          : battleResult.finalGame;
        // The same board, now carrying its result. Replacing it does not
        // disturb the analysis: a position's identity is its board, whose turn
        // it is and how many moves it took, and none of those changed.
        const finalIndex = Math.max(0, positionsRef.current.length - 1);
        positionsRef.current[finalIndex] = finalGame;

        setPositions(positionsRef.current.slice());
        setMoves(movesRef.current.slice());
        setResult({ winner: battleResult.winner, endReason: battleResult.endReason });
        setPgn(
          botBattlePGN({
            blueProfile,
            endReason: battleResult.endReason,
            mode,
            moves: movesRef.current,
            redProfile,
            startGame: positionsRef.current[0],
            startedAtUnixMs: startedAtRef.current,
            winner: battleResult.winner,
          }),
        );
        setMatchState('finished');
      })
      .catch((error) => {
        if (error?.name === 'AbortError' || controller.signal.aborted) return;
        setMatchError(error.message);
        setMatchState('error');
      });

    return () => controller.abort();
  }, [blueProfile, initialGame, mode, redProfile, updateCursor]);

  // The analysis, and the only thing on this screen that grades a move. It
  // walks the same game the bots are playing, at a budget that outsearches
  // every bot but the top rung, so it runs behind the board rather than with
  // it — `behind` is how far, and every grade appears the moment it lands.
  const running = matchState === 'running';
  const analysis = useGameAnalysis({
    mode,
    moves,
    positions,
    preset,
    streaming: running,
  });
  const report = analysis.report;

  if (!mode || !initialGame) {
    return (
      <SafeAreaView style={styles.safeArea}>
        <View style={styles.centered}>
          <Text style={styles.emptyTitle}>Choose a battle first</Text>
          <Pressable onPress={() => navigation.goBack()} style={styles.backToModes}>
            <Text style={styles.backToModesText}>Return to lobby</Text>
          </Pressable>
        </View>
      </SafeAreaView>
    );
  }

  const isWide = width >= 900 && width > height;
  const boardSize = Math.floor(
    Math.max(
      220,
      Math.min(
        620,
        isWide ? width - 455 : width - 60,
        isWide ? height - 245 : height * 0.47,
      ),
    ),
  );
  const latestGame = positions[positions.length - 1] ?? initialGame;
  const visibleGame = positions[Math.min(cursor, positions.length - 1)] ?? latestGame;
  const visibleMove = cursor > 0 ? report.moves[cursor - 1] ?? null : null;
  const visibleAnalysis = analysis.entries[cursor]?.analysis ?? null;
  // The evaluation for the position on screen, or the last one the analysis
  // reached if it has not got here yet. Holding the previous number is honest
  // in a way that showing zero is not: nothing says the game is level.
  const recentScore = (() => {
    for (let index = Math.min(cursor, analysis.entries.length - 1); index >= 0; index -= 1) {
      const score = analysis.entries[index]?.analysis?.redScore;
      if (typeof score === 'number') return score;
    }
    return null;
  })();
  const captures = capturedPieces(visibleGame);
  const latestIndex = positions.length - 1;
  const chartPoints = report.evaluations.map((point) => ({
    index: point.index,
    redPercent: winPercent(point.redScore, mode.id),
  }));
  const botForMove = visibleMove?.player === 'Blue' ? blueProfile : redProfile;
  const currentExplanation = moveExplanation(visibleMove, botForMove.name, analysis);
  const analysisNote = analysisProgress(analysis, preset, running);

  const playerStack = (
    <View style={[styles.playerStack, { width: boardSize + 38 }]}>
      <PlayerBar
        badge="BOT"
        captured={captures.Blue}
        color="Blue"
        fallbackLabel={blueProfile.name}
        gameStatus={running ? 'InProgress' : 'Finished'}
        metaOverride={`Level ${blueProfile.rating} · ${
          running && latestGame.currentTurn === 'Blue' ? 'searching' : running ? 'waiting' : 'final'
        }`}
        profile={{ username: blueProfile.name }}
        turnColor={latestGame.currentTurn}
      />
      <View style={styles.boardWithEval}>
        <EvalBar height={boardSize} redScore={recentScore} />
        <Board
          analysisArrows={visibleAnalysis?.lines ?? []}
          boardSize={boardSize}
          canMove={false}
          grid={visibleGame.grid}
          lastMove={visibleMove ? { from: visibleMove.from, to: visibleMove.to } : null}
          lastMoveGrade={visibleMove?.grade ?? null}
          modeId={mode.id}
          onPieceDrop={() => {}}
          onTilePress={() => {}}
          playerColor="Red"
          replayIndex={cursor}
          replayPositions={positions}
          selectedTile={null}
          validMoves={[]}
        />
      </View>
      <PlayerBar
        badge="BOT"
        captured={captures.Red}
        color="Red"
        fallbackLabel={redProfile.name}
        gameStatus={running ? 'InProgress' : 'Finished'}
        metaOverride={`Level ${redProfile.rating} · ${
          running && latestGame.currentTurn === 'Red' ? 'searching' : running ? 'waiting' : 'final'
        }`}
        profile={{ username: redProfile.name }}
        turnColor={latestGame.currentTurn}
      />
      <ReplayControls
        current={cursor}
        label={running && cursor === latestIndex ? 'LIVE' : 'MOVE'}
        onFirst={goToFirst}
        onLast={goToLast}
        onNext={stepForward}
        onPrevious={stepBack}
        total={latestIndex}
      />
    </View>
  );

  const panel = (
    <View style={styles.panelStack}>
      <View style={styles.statusCard}>
        <View style={styles.statusTop}>
          <View>
            <Text style={styles.cardEyebrow}>BOT BATTLE</Text>
            <Text style={styles.statusTitle}>
              {running
                ? `${latestGame.currentTurn} is calculating`
                : result
                  ? resultLabel(result.winner, result.endReason)
                  : 'Battle stopped'}
            </Text>
          </View>
          {running ? <ActivityIndicator color={colors.accent} size="small" /> : null}
        </View>
        <Text style={styles.statusBody}>
          {cursor === latestIndex
            ? running
              ? `Following live at move ${latestIndex}. The bots continue independently of these controls.`
              : `${moves.length} moves played. Use the timeline to review the complete fight.`
            : `Viewing move ${cursor} while the bots ${running ? 'keep fighting' : 'remain at the final position'}. Press End to catch up.`}
        </Text>
        <Text
          accessibilityLiveRegion="polite"
          style={[styles.statusBody, analysis.status === 'error' && styles.statusError]}
        >
          {analysisNote}
        </Text>
      </View>

      <AccuracyCard
        accuracy={report.accuracy}
        pendingDetail={
          analysis.status === 'error'
            ? 'The analysis stopped before it could finish.'
            : 'Reported once every move has a grade.'
        }
        players={{ Blue: blueProfile, Red: redProfile }}
      />

      {pgn && !running ? (
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
                await Clipboard.setStringAsync(pgn);
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
      ) : null}

      <EvalChart
        currentIndex={cursor}
        moves={report.moves}
        onSelect={updateCursor}
        points={chartPoints}
        total={positions.length}
      />

      {mode.features?.includes('territory') ? <TerritoryMeter grid={visibleGame.grid} /> : null}

      <View style={styles.currentCard}>
        <View style={styles.currentTop}>
          <View style={styles.currentCopy}>
            <Text style={styles.cardEyebrow}>
              {visibleMove
                ? `MOVE ${visibleMove.index + 1} · ${visibleMove.player.toUpperCase()}`
                : 'OPENING POSITION'}
            </Text>
            <Text style={styles.currentMove}>
              {visibleMove ? formatMove(visibleMove) : `${redProfile.name} to move`}
            </Text>
          </View>
          {visibleMove?.grade ? (
            <MoveQualityBadge grade={visibleMove.grade} />
          ) : visibleMove ? (
            <ActivityIndicator color={colors.textMuted} size="small" />
          ) : null}
        </View>
        <Text style={styles.currentDetail}>{currentExplanation}</Text>
      </View>

      <EngineLinesCard
        analysis={visibleAnalysis}
        emptyMessage={
          visibleGame.status === 'Finished'
            ? 'The game has ended.'
            : `The analysis is ${plural(analysis.behind, 'move')} behind this one.`
        }
        meta={
          visibleAnalysis
            ? `DEPTH ${visibleAnalysis.depth}/${visibleAnalysis.selectiveDepth} · ${visibleAnalysis.nodes.toLocaleString()} NODES`
            : null
        }
        turn={visibleGame.currentTurn}
      />

      <MoveAnalysisList
        emptyText="The first move will appear as soon as Red finishes searching."
        moves={report.moves}
        onSelect={updateCursor}
        selectedIndex={cursor}
        title="LIVE MOVE ANALYSIS"
      />
    </View>
  );

  return (
    <SafeAreaView style={styles.safeArea} edges={['top', 'right', 'bottom', 'left']}>
      <View style={styles.screen}>
        <View style={styles.topBar}>
          <Pressable
            accessibilityLabel="Leave the bot battle"
            accessibilityRole="button"
            onPress={() => navigation.goBack()}
            style={({ pressed }) => [styles.backButton, pressed && styles.pressed]}
          >
            <Text style={styles.backIcon}>‹</Text>
          </Pressable>
          <View style={styles.titleCopy}>
            <Text numberOfLines={1} style={styles.kicker}>
              {mode.shortCode} · BOT VS BOT · {running ? `MOVE ${latestIndex}` : 'FINAL'}
            </Text>
            <Text numberOfLines={1} style={styles.title}>
              {redProfile.name} vs {blueProfile.name}
            </Text>
          </View>
          <View style={styles.headerRight}>
            <View style={styles.modeBadge}>
              <View style={[styles.colorDot, { backgroundColor: players.Red.strong }]} />
              <Text style={styles.modeBadgeText}>{redProfile.rating}</Text>
              <Text style={styles.versus}>VS</Text>
              <View style={[styles.colorDot, { backgroundColor: players.Blue.strong }]} />
              <Text style={styles.modeBadgeText}>{blueProfile.rating}</Text>
            </View>
            <AnalysisPresetPicker onChange={setPreset} value={preset} />
          </View>
        </View>

        {isWide ? (
          <View style={styles.wideLayout}>
            {playerStack}
            <ScrollView
              contentContainerStyle={styles.widePanelContent}
              showsVerticalScrollIndicator={false}
              style={[styles.widePanel, { maxHeight: height - 92 }]}
            >
              {panel}
            </ScrollView>
          </View>
        ) : (
          <ScrollView
            contentContainerStyle={styles.mobileContent}
            showsVerticalScrollIndicator={false}
          >
            {playerStack}
            {panel}
          </ScrollView>
        )}

        {matchError ? (
          <View style={styles.errorBanner}>
            <Text style={styles.errorText}>{matchError}</Text>
          </View>
        ) : null}
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
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  emptyTitle: { color: colors.textStrong, fontSize: 24, fontWeight: '900' },
  backToModes: {
    marginTop: 16,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: radius.medium,
    backgroundColor: colors.accent,
  },
  backToModesText: { color: colors.textStrong, fontWeight: '900' },
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
  modeBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 9,
    paddingVertical: 7,
    borderRadius: radius.medium,
    backgroundColor: colors.surface,
  },
  colorDot: { width: 7, height: 7, borderRadius: 4 },
  headerRight: { alignItems: 'flex-end', gap: 5 },
  statusError: { color: colors.dangerText },
  modeBadgeText: { color: colors.textSoft, fontSize: 9, fontWeight: '900' },
  versus: { color: colors.textFaint, fontSize: 7, fontWeight: '900' },
  wideLayout: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'center',
    gap: 18,
  },
  playerStack: { alignItems: 'center', gap: 7 },
  boardWithEval: { flexDirection: 'row', alignItems: 'stretch', gap: 7 },
  widePanel: { width: 360 },
  widePanelContent: { paddingBottom: 20 },
  mobileContent: { alignItems: 'center', gap: 14, paddingBottom: 28 },
  panelStack: { width: '100%', gap: 10 },
  statusCard: {
    padding: 14,
    borderRadius: radius.large,
    borderWidth: 1,
    borderColor: colors.accentBorder,
    backgroundColor: colors.accentSurface,
  },
  statusTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  cardEyebrow: { color: colors.textFaint, fontSize: 8, fontWeight: '900', letterSpacing: 1.2 },
  statusTitle: { color: colors.textStrong, fontSize: 17, fontWeight: '900', marginTop: 5 },
  statusBody: { color: colors.accentSoft, fontSize: 10, lineHeight: 15, marginTop: 8 },
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
  currentCard: {
    padding: 13,
    borderRadius: radius.large,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  currentTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  currentCopy: { flex: 1, minWidth: 0 },
  currentMove: { color: colors.textStrong, fontSize: 17, fontWeight: '900', marginTop: 4 },
  currentDetail: { color: colors.textMuted, fontSize: 9, lineHeight: 14, marginTop: 9 },
  pressed: { opacity: 0.68 },
  errorBanner: {
    position: 'absolute',
    right: 12,
    bottom: 12,
    left: 12,
    padding: 12,
    borderRadius: radius.medium,
    borderWidth: 1,
    borderColor: colors.dangerBorder,
    backgroundColor: colors.dangerSurface,
  },
  errorText: { color: colors.dangerText, fontSize: 10, fontWeight: '800' },
});
