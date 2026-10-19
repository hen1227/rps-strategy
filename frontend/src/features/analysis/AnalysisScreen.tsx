import { useIsFocused } from 'expo-router';
import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import EngineLinesCard from './EngineLinesCard';
import EngineSwitch from './EngineSwitch';
import EvalBar from './EvalBar';
import MoveQualityBadge from './MoveQualityBadge';
import QuietMoveMeter from './QuietMoveMeter';
import TerritoryMeter from './TerritoryMeter';
import {
  applyAnalysisMove,
  createAnalysisGame,
  createAnalysisGameOn,
  moveLabel,
  ownerRowsFrom,
  sideToMove,
  startingPositionFromGrid,
  type AnalysisGame,
  type StartingBoard,
} from '@/engine/analysisGame';
import {
  formatLoss,
  reviewSourceFromPGN,
  type GradedMove,
  type ReviewMove,
} from '@/engine/gameReview';
import {
  engineSupportsMode,
  engineUnavailableMessage,
  isEngineAvailable,
} from '@/engine/rpsfish/client';
import { interactiveLimits, type AnalysisEffort } from '@/engine/analysisBudget';
import type { RefinePass } from '@/engine/gameAnalysis';
import type { Analysis } from '@/engine/rpsfish/protocol';
import Board from '@/features/board/Board';
import BoardExportButton from '@/features/board/BoardExportButton';
import type { ShareCardInput } from '@/features/board/export/shareCard';
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
import { useGoTo } from '@/navigation/stack';
import { up } from '@/navigation/upFrom';
import { useSettledSearchParams } from '@/navigation/useSettledSearchParams';
import BackLink from '@/ui/BackLink';
import { arrows } from '@/ui/arrows';
import { GhostButton } from '@/ui/primitives';
import { toggleEngineAnalysis, useEngineAnalysis } from '@/store/enginePreference';
import { useGameStore } from '@/store/gameStore';
import { useReviewHandoff } from '@/store/reviewHandoff';
import { colors, players, radius, themedSheet } from '@/theme';
import type {
  ModeDefinition,
  Move,
  Position,
  SideColor,
  StartingPosition,
} from '@/types/game';

/** How wide the page is, at the least, on a wide screen. */
const SCREEN_WIDTH = 1200;
/**
 * The room beside the board on a wide screen: the panel's 350, the gap before
 * it, the eval bar and its gap, and the page's padding.
 */
const SIDE_PANEL = 430;

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
// grade down from. Both now deepen on their own — the search by iterative
// deepening, which streams every completed depth into the arrows, and the
// grades by regrading the whole line at each rung the device can afford — so
// there is nothing left to choose between them. One switch drives both, and it
// says how much of the device to spend rather than how deep to look.

const confidenceLabel = (confidence: number) => {
  if (confidence >= 80) return 'HIGH';
  if (confidence >= 50) return 'MEDIUM';
  return 'LOW';
};

// A move can give up nothing without being the move the engine named, so
// "best was X" is only said when playing X would actually have been better.
// The depth is not repeated here: the move-quality card's header says what the
// grades were measured at, once, for all of them.
const lastMoveVerdict = (entry: ReviewMove<BoardPlay>) => {
  if (entry.pending) return 'Grading…';
  const best = entry.bestMove ? moveLabel(entry.bestMove) : 'not available';
  if (entry.grade.key === 'great') return 'The only good move.';
  if (entry.isTopMove) return "The engine's choice.";
  if (entry.lossPercent < 0.05) return `As strong as ${best}.`;
  return `Best was ${best} · ${formatLoss(entry.lossPercent)} lost`;
};

/**
 * How deep the engine has looked, in the coach card's corner.
 *
 * All there is to say about a search in progress. The arrows, the bar and the
 * lines already change as each depth lands, so the sentence that used to
 * promise they would was a second copy of what the board was showing — and,
 * being a sentence, it changed length as the depth went up and moved the
 * page under it. `+` and the spinner mean a deeper answer is on its way.
 */
function SearchDepth({ analysis, status }: { analysis: Analysis | null; status: SearchStatus }) {
  const thinking = status === 'thinking';
  if (!thinking && !analysis) return null;
  return (
    <View
      accessibilityLabel={
        thinking
          ? `Searching${analysis ? `, depth ${analysis.depth} so far` : ''}`
          : `Searched to depth ${analysis?.depth}`
      }
      style={styles.depthChip}
    >
      {thinking ? (
        <ActivityIndicator color={colors.textMuted} size="small" style={styles.depthSpinner} />
      ) : null}
      {analysis ? (
        <Text style={styles.depthText}>
          DEPTH {analysis.depth}
          {thinking ? '+' : ''}
        </Text>
      ) : null}
    </View>
  );
}

/** QUICK and REACH: a setting that is on or off, drawn the way `EngineSwitch` is. */
function SwitchChip({
  checked,
  hint,
  label,
  name,
  onToggle,
}: {
  checked: boolean;
  hint: string;
  label: string;
  /** What a screen reader calls it, which the chip's one word does not say. */
  name: string;
  onToggle: () => void;
}) {
  return (
    <Pressable
      accessibilityHint={hint}
      accessibilityLabel={name}
      accessibilityRole="switch"
      accessibilityState={{ checked }}
      onPress={onToggle}
      style={({ pressed }) => [
        styles.switchChip,
        checked && styles.switchChipActive,
        pressed && styles.buttonPressed,
      ]}
    >
      <Text style={[styles.switchChipText, checked && styles.switchChipTextActive]}>{label}</Text>
    </Pressable>
  );
}

interface AnalysisPanelProps {
  analysis: Analysis | null;
  canMakeBestMove: boolean;
  /** Whether the grades may still be replaced by a deeper pass. */
  deeperToCome: boolean;
  /**
   * Whether RPSFish is being asked about this board at all.
   *
   * Off, everything on this panel that is the engine's opinion is gone rather
   * than blank — the coach, the ranked lines, the move grades — and what is
   * left is the board's own account of itself: whose turn it is, how the
   * territory stands, how near the quiet-move draw is, and the tools for
   * setting a position up and walking a line out.
   */
  engineOn: boolean;
  engineState: SearchStatus;
  /**
   * The board as the export dialog needs it: the position, plus the little the
   * picture can honestly say about it. Built by the board rather than here,
   * because the last move played is the line's, not the position's.
   */
  exportBoard: ShareCardInput;
  game: AnalysisGame;
  gradeError: string | null;
  gradedMoves: ReviewMove<BoardPlay>[];
  /** The depth the grades below were measured at. */
  gradeDepth: number;
  onMakeBestMove: () => void;
  onToggleEngine: () => void;
  onToggleQuick: () => void;
  quick: boolean;
  /** A deeper grading pass in flight, and how far through the line it is. */
  refining: RefinePass | null;
  onSetPosition: () => void;
  /** Play the board on screen out, against a bot or somebody next to you. */
  onPlayOut: (against: 'bot' | 'friend') => void;
  /**
   * Whether a bot may be offered this mode.
   *
   * The same question the engine is asked, and asked rather than assumed: a bot
   * handed a mode RPSFish refuses does not fail loudly, it quietly plays at
   * random, and a position somebody built deserves better than that. A shared
   * board needs no such check — two people can play anything.
   */
  playBotOffered: boolean;
  /** Absent in a mode with no goal row for the reach tool to measure against. */
  onToggleReach?: () => void;
  /** The reach tool's own controls, drawn under the switch that shows them. */
  reachPanel?: ReactNode;
  reachShowing?: boolean;
}

function AnalysisPanel({
  analysis,
  canMakeBestMove,
  deeperToCome,
  engineOn,
  engineState,
  exportBoard,
  game,
  gradeDepth,
  gradeError,
  gradedMoves,
  onMakeBestMove,
  onPlayOut,
  onSetPosition,
  playBotOffered,
  onToggleEngine,
  onToggleQuick,
  onToggleReach,
  quick,
  reachPanel,
  reachShowing = false,
  refining,
}: AnalysisPanelProps) {
  const lastMove = gradedMoves[gradedMoves.length - 1];
  const activeColor = game.currentTurn;
  const bestLine = analysis?.lines[0];

  return (
    <View style={styles.panelStack}>
      {/*
        The coach is the position and the three switches that decide what is
        drawn on it. Everything that takes the board somewhere else — another
        position, another app, a game — is in the tool grid further down, so
        this card no longer wraps five differently-sized buttons around its
        switches.
      */}
      <View style={styles.coachCard}>
        <View style={styles.coachHeader}>
          <Text style={styles.cardEyebrow}>{engineOn ? 'RPSFISH COACH' : 'ANALYSIS BOARD'}</Text>
          {engineOn ? <SearchDepth analysis={analysis} status={engineState} /> : null}
        </View>
        {/*
          The switches share the title's line, on the right where the card was
          empty. They wrap under it rather than crushing it when the text is
          large.
        */}
        <View style={styles.coachTitleRow}>
          <Text style={styles.cardTitle}>
            {game.status === 'Finished'
              ? game.winner === 'Neutral'
                ? 'Draw'
                : `${game.winner} wins`
              : `${activeColor} to move`}
          </Text>
          <View style={styles.switchRow}>
            <EngineSwitch enabled={engineOn} offDetail="YOUR BOARD" onToggle={onToggleEngine} />
            {/* How hard to think, asked only once there is something thinking. */}
            {engineOn ? (
              <SwitchChip
                checked={quick}
                hint="Quick search uses a shallow depth. Turn it off for deeper analysis."
                label="QUICK"
                name="Quick analysis"
                onToggle={onToggleQuick}
              />
            ) : null}
            {onToggleReach ? (
              <SwitchChip
                checked={reachShowing}
                hint="Show travel distances and safe routes to the goal."
                label="REACH"
                name={reachShowing ? 'Hide the reach maps' : 'Show the reach maps'}
                onToggle={onToggleReach}
              />
            ) : null}
          </View>
        </View>
        {/*
          Nothing to press when nothing has named a best move, and nothing to
          name once the game is over. One line, so a move arriving or a depth
          landing never changes the card's height.
        */}
        {engineOn && game.status === 'InProgress' ? (
          <Pressable
            accessibilityLabel={
              bestLine ? `Make best move, ${moveLabel(bestLine)}` : 'Make best move'
            }
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
            <Text style={styles.bestMoveButtonText}>Make Best Move</Text>
            <Text numberOfLines={1} style={styles.bestMoveButtonDetail}>
              {bestLine ? moveLabel(bestLine) : engineState === 'thinking' ? '…' : ''}
            </Text>
            <Text style={styles.bestMoveButtonArrow}>→</Text>
          </Pressable>
        ) : null}
      </View>

      {reachPanel}

      {engineOn ? (
        <EngineLinesCard
          analysis={analysis}
          emptyMessage={
            engineState === 'error' ? 'Engine analysis unavailable.' : 'No legal continuation.'
          }
          meta={analysis ? `${confidenceLabel(analysis.confidence)} CONFIDENCE` : null}
          // Held open at its full height while the next position is searched,
          // so everything under it stays where it was when a move is played.
          pendingRows={engineState === 'thinking' ? 3 : 0}
          turn={activeColor}
        />
      ) : null}

      {lastMove && (
        <View style={styles.lastMoveCard}>
          <View style={styles.lastMoveTop}>
            <View>
              <Text style={styles.cardEyebrow}>LAST MOVE</Text>
              <Text style={styles.lastMoveNotation}>
                {lastMove.index + 1}. {moveLabel(lastMove)}
              </Text>
            </View>
            {/*
              With the engine off the card keeps its one true half — which move
              was last played — and drops the half that was a verdict on it.
            */}
            {!engineOn ? null : lastMove.pending ? (
              <ActivityIndicator color={colors.textMuted} size="small" />
            ) : (
              <MoveQualityBadge grade={lastMove.grade} />
            )}
          </View>
          {engineOn ? (
            <Text style={styles.bestMoveCopy}>{lastMoveVerdict(lastMove)}</Text>
          ) : null}
        </View>
      )}

      {game.mode.features?.includes('territory') && <TerritoryMeter grid={game.grid} />}
      <QuietMoveMeter game={game} />

      {/*
        What can be done with the board, in one grid: the two that draw it
        somewhere else, then the two that play it out. Equal cells, so the
        rows line up whichever of them a mode offers.
      */}
      <View style={styles.toolGrid}>
        <View style={styles.toolRow}>
          <View style={styles.toolCell}>
            <GhostButton
              accessibilityLabel="Set up a custom analysis position"
              compact
              label="SET POSITION"
              onPress={onSetPosition}
            />
          </View>
          {/*
            The other direction through the same door: SET POSITION draws a
            board, this hands the one already drawn to anybody — or back to the
            PGN box on this screen, which reads what it writes.
          */}
          <View style={styles.toolCell}>
            <BoardExportButton board={exportBoard} />
          </View>
        </View>
        <View style={styles.toolRow}>
          {playBotOffered && (
            <View style={styles.toolCell}>
              <GhostButton
                accessibilityLabel={`Play this position against a bot, as ${activeColor}`}
                compact
                label="PLAY A BOT"
                onPress={() => onPlayOut('bot')}
              />
            </View>
          )}
          {/* The lobby's name for a game two people share one device for. */}
          <View style={styles.toolCell}>
            <GhostButton
              accessibilityLabel="Play this position with somebody on this device"
              compact
              label="PASS AND PLAY"
              onPress={() => onPlayOut('friend')}
            />
          </View>
        </View>
      </View>

      {/*
        The line walked out on this board, graded or not. With the engine off it
        is a plain list of what has been played — still the thing you steer by
        when you have taken a position apart four moves deep and want to see how
        you got there. Absent until there is a move to list: a card whose only
        content is a promise of content is the half-empty panel again.
      */}
      {gradedMoves.length > 0 || gradeError ? (
        <View style={styles.historyCard}>
          <View style={styles.cardHeader}>
            <Text style={styles.cardEyebrow}>{engineOn ? 'MOVE QUALITY' : 'MOVES'}</Text>
            {/*
              What the grades below currently mean. Worth saying because they
              move: a grade written at depth 6 can become a different grade at
              depth 12, and a reviewer who saw one change should be able to see
              why rather than doubt what they read the first time.
            */}
            {engineOn && gradedMoves.length > 0 ? (
              <Text style={styles.historyMeta}>
                {refining
                  ? `DEPTH ${refining.limits.maxDepth} · ${refining.done}/${refining.total}`
                  : `DEPTH ${gradeDepth}${deeperToCome ? '+' : ''}`}
              </Text>
            ) : null}
          </View>
          {gradeError ? <Text style={styles.historyEmpty}>{gradeError}</Text> : null}
          <View style={styles.historyList}>
            {[...gradedMoves].reverse().map((entry) => (
              <View key={entry.index} style={styles.historyRow}>
                <Text style={styles.historyNumber}>{entry.index + 1}</Text>
                <View style={[styles.historyColor, entry.player === 'Red' ? styles.redDot : styles.blueDot]} />
                <Text style={styles.historyMove}>{moveLabel(entry)}</Text>
                {!engineOn ? null : entry.pending ? (
                  <ActivityIndicator color={colors.textMuted} size="small" />
                ) : (
                  <MoveQualityBadge compact grade={entry.grade} />
                )}
              </View>
            ))}
          </View>
        </View>
      ) : null}
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

  const unavailable = engineUnavailableMessage(mode.id);
  if (unavailable) {
    return (
      <SafeAreaView style={styles.safeArea} edges={['top', 'right', 'bottom', 'left']}>
        <View style={styles.screen}>
          <View style={styles.disabledCard}>
            <Text style={styles.cardEyebrow}>RPSFISH TOURNAMENT LOCK</Text>
            <Text style={styles.cardTitle}>Intransitive analysis is temporarily disabled</Text>
            <Text style={styles.cardBody}>{unavailable}</Text>
            <BackLink href={up.analysis.href} label={up.analysis.label} />
          </View>
        </View>
      </SafeAreaView>
    );
  }

  // Keyed by mode so switching modes rebuilds the board rather than trying to
  // carry a line from one set of rules into another.
  return <AnalysisBoard key={mode.id} mode={mode} />;
}

function AnalysisBoard({ mode }: { mode: ModeDefinition }) {
  // The analysis board is full-screen, so a record opened from it takes its
  // place rather than covering it over. See `navigation/stack`.
  const go = useGoTo();
  const modes = useGameStore((state) => state.modes);
  const draggingPiece = usePieceDrag((state) => state.dragging);
  const startBotGame = useGameStore((state) => state.startBotGame);
  const startLocalGame = useGameStore((state) => state.startLocalGame);
  const [game, setGame] = useState(() => createAnalysisGame(mode));
  // Whether this board asks RPSFish anything. Off by default — see
  // `store/enginePreference.ts` — which turns this screen into what it is
  // underneath: a board you play both sides of, with the position setup, the
  // reach maps and the meters, and no opinions on it.
  const engineOn = useEngineAnalysis();
  // False while a game started from this board is laid over it — see
  // `navigation/stack`. The board stays mounted underneath so its line is
  // there to come back to, but it has nothing to say while it is covered.
  const focused = useIsFocused();
  const [effort, setEffort] = useState<AnalysisEffort>('full');
  const [history, setHistory] = useState<BoardMove[]>([]);
  const [pastGames, setPastGames] = useState<AnalysisGame[]>([]);
  const [redoMoves, setRedoMoves] = useState<RedoStep[]>([]);
  // The whole board this line began on, not just its pieces: the side to move
  // and the territory are part of the position somebody set up, and Reset has
  // to put all three back.
  const openingBoard = (): StartingBoard => {
    const opening = createAnalysisGame(mode);
    return { currentTurn: opening.currentTurn, era: opening.era, grid: opening.grid };
  };
  const [startingBoard, setStartingBoard] = useState<StartingBoard>(openingBoard);
  const [positionModalOpen, setPositionModalOpen] = useState(false);
  const [positionModalInitial, setPositionModalInitial] = useState<StartingBoard>(openingBoard);
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
  //
  // Paused while the board is covered. A bot thinks on the same lane as this
  // search, so an analysis board left searching underneath a game would make
  // the bot wait for it. The grades below are left running: they are on the
  // other lane, and switching them off throws every grade away.
  const positionAnalysis = usePositionAnalysis({
    position: game,
    history: pastGames,
    limits: interactiveLimits({ effort }),
    enabled: engineOn && focused,
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
    enabled: engineOn,
    mode: game.mode,
    moves,
    positions,
    effort,
    // Another move can always arrive on a board somebody is playing on, so the
    // position on screen is not graded here — the search above already covers
    // it, and grading it now would cost the move played out of it its grade.
    streaming: game.status === 'InProgress',
  });
  const gradedMoves = gradeAnalysis.report?.moves ?? [];
  const lastPlay = gradedMoves[gradedMoves.length - 1];
  const lastGradedMove: GradedMove<BoardPlay> | null =
    lastPlay && !lastPlay.pending ? lastPlay : null;

  // The height of the row the board shares with its panel on a wide screen,
  // measured. The board grows into it — nothing sits under it here — and the
  // panel is bounded by it, so the move list scrolls down to the bottom of the
  // screen rather than stopping at the board's edge over an empty band.
  const [wideRowHeight, setWideRowHeight] = useState<number | null>(null);
  const { boardSize, isWide } = useBoardLayout({
    sidePanel: SIDE_PANEL,
    narrowHeightShare: 0.55,
    fill: true,
    maxHeight: wideRowHeight ?? undefined,
  });
  // A search in flight is never a reason to hold a move back. The engine is
  // answering a question about the board; the board is not waiting on the
  // answer. Playing on abandons the search for the position just left and
  // starts one for the position arrived at — the same thing undo and redo have
  // always done, and the same thing `usePositionAnalysis` does on any position
  // change. Grades are unaffected: they come from the walk below, which
  // searches each position itself rather than reading this one.
  const canMove = game.status === 'InProgress';

  const performMove = (from: Position, to: Position) => {
    if (!canMove) return;
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
    // The game laid over this board has arrow keys of its own.
    enabled: focused,
    onFirst: undoMove,
    onLast: redoMove,
    onNext: redoMove,
    onPrevious: undoMove,
  });

  const makeBestMove = () => {
    const bestMove = analysis?.lines[0];
    if (game.status !== 'InProgress' || !bestMove) return;
    performMove(bestMove.from, bestMove.to);
  };

  const startFromPosition = (board: StartingBoard) => {
    clearSelection();
    setHistory([]);
    setPastGames([]);
    setRedoMoves([]);
    setStartingBoard(board);
    setGame(createAnalysisGameOn(mode, board));
    setPositionModalOpen(false);
  };

  const reset = () => startFromPosition(startingBoard);

  /**
   * Hand the board on screen to a real game.
   *
   * The player takes the side to move. A position is set up to be played
   * *from* — the decision in front of whoever is on move is the whole of it —
   * so dealing that seat at random would hand it to the other person half the
   * time. Neither game is announced anywhere; `app/_layout` routes to the board
   * on its own once one exists.
   */
  const playOut = (against: 'bot' | 'friend') => {
    const seat = sideToMove(game.currentTurn);
    const start: StartingBoard = { currentTurn: seat, era: game.era, grid: game.grid };
    if (against === 'bot') startBotGame({ mode, playerColor: seat, start });
    else startLocalGame({ mode, start, viewColor: seat });
  };

  const board = (
    <View style={styles.boardWithEval}>
      {/* The bar, the arrows and the grade are the engine drawing on the board. */}
      {engineOn ? <EvalBar height={boardSize} redScore={analysis?.redScore} /> : null}
      <Board
        analysisArrows={engineOn ? analysis?.lines ?? [] : []}
        boardSize={boardSize}
        canMove={canMove}
        grid={game.grid}
        lastMove={history[history.length - 1]?.move ?? null}
        lastMoveGrade={engineOn ? lastGradedMove?.grade ?? null : null}
        modeId={game.mode.id}
        era={game.era}
        movableColor={game.currentTurn}
        onPieceDrop={performMove}
        onTilePress={(square) => {
          if (reachTool.handleTilePress(square)) return;
          selection.selectTile(square);
        }}
        overlay={reachTool.overlay}
        playerColor="Blue"
        selectedTile={selectedTile}
        validMoves={validMoves}
      />
    </View>
  );

  const panel = (
    <AnalysisPanel
      analysis={analysis}
      canMakeBestMove={game.status === 'InProgress' && Boolean(analysis?.lines[0])}
      deeperToCome={gradeAnalysis.deeperToCome}
      engineOn={engineOn}
      engineState={engineState}
      exportBoard={{
        grid: game.grid,
        currentTurn: game.currentTurn,
        mode,
        era: game.era,
        lastMove: history[history.length - 1]?.move ?? null,
        detail: {
          heading: 'ANALYSIS',
          caption:
            game.status === 'Finished'
              ? game.winner === 'Neutral'
                ? 'Drawn'
                : `${game.winner} wins`
              : `${game.currentTurn} to move · move ${game.moveNumber + 1}`,
        },
      }}
      game={game}
      gradeDepth={gradeAnalysis.depth}
      gradeError={gradeAnalysis.error}
      gradedMoves={gradedMoves}
      onMakeBestMove={makeBestMove}
      onPlayOut={playOut}
      // The bot is RPSFish, so a build without it would play random moves.
      playBotOffered={isEngineAvailable() && engineSupportsMode(mode.id)}
      onSetPosition={() => {
        // The board as it stands, whose move it is included — opening the
        // editor part-way down a line should not silently hand the move back.
        setPositionModalInitial({
          currentTurn: game.currentTurn,
          era: game.era,
          grid: game.grid,
        });
        setPositionModalOpen(true);
      }}
      onToggleEngine={toggleEngineAnalysis}
      onToggleQuick={() => setEffort((current) => (current === 'quick' ? 'full' : 'quick'))}
      onToggleReach={reachTool.available ? reachTool.toggle : undefined}
      quick={effort === 'quick'}
      reachPanel={<ReachPanel tool={reachTool} />}
      reachShowing={reachTool.active}
      refining={gradeAnalysis.refining}
    />
  );

  return (
    <SafeAreaView style={styles.safeArea} edges={['top', 'right', 'bottom', 'left']}>
      {/*
        As wide as the board and its panel need, and never narrower than the
        page has always been: a board grown into a tall window takes the room
        it needs from the margins, not from the panel.
      */}
      <View
        style={[
          styles.screen,
          isWide && { maxWidth: Math.max(SCREEN_WIDTH, boardSize + SIDE_PANEL) },
        ]}
      >
        <View style={styles.topBar}>
          <BackLink href={up.analysis.href} label={up.analysis.label} />
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
            {/*
              A step through the line is the thing pressed most on this page,
              so on a phone it moves under the board, in the thumb's reach and
              out of a header it used to wrap onto a second row.
            */}
            {isWide ? (
              <>
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
                  <Text style={styles.historyButtonArrow}>{arrows.back}</Text>
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
                  <Text style={styles.historyButtonArrow}>{arrows.forward}</Text>
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  onPress={reset}
                  style={({ pressed }) => [styles.resetButton, pressed && styles.buttonPressed]}
                >
                  <Text style={styles.resetText}>Reset</Text>
                </Pressable>
              </>
            ) : null}
          </View>
        </View>

        {isWide ? (
          <View
            onLayout={(event) => {
              const next = Math.floor(event.nativeEvent.layout.height);
              setWideRowHeight((current) => (current === next ? current : next));
            }}
            style={styles.wideLayout}
          >
            <View style={styles.boardColumn}>{board}</View>
            <ScrollView
              contentContainerStyle={styles.widePanelContent}
              showsVerticalScrollIndicator={false}
              style={[styles.widePanel, { maxHeight: wideRowHeight ?? boardSize }]}
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
            <View style={styles.phoneHistory}>
              <View style={styles.toolCell}>
                <GhostButton
                  accessibilityLabel="Undo move"
                  compact
                  disabled={!canUndo}
                  label={`${arrows.back} UNDO`}
                  onPress={undoMove}
                />
              </View>
              <View style={styles.toolCell}>
                <GhostButton
                  accessibilityLabel="Redo move"
                  compact
                  disabled={!canRedo}
                  label={`REDO ${arrows.forward}`}
                  onPress={redoMove}
                />
              </View>
              <View style={styles.toolCell}>
                <GhostButton
                  accessibilityLabel="Reset to the starting position"
                  compact
                  // Nothing has been played, so there is nothing to put back.
                  disabled={!canUndo && !canRedo}
                  label="RESET"
                  onPress={reset}
                />
              </View>
            </View>
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
        describes="position"
        initialOwners={ownerRowsFrom(positionModalInitial.grid)}
        initialPosition={startingPositionFromGrid(positionModalInitial.grid)}
        initialTurn={sideToMove(positionModalInitial.currentTurn)}
        mode={mode}
        onApply={({ board }) => startFromPosition(board)}
        onClose={() => setPositionModalOpen(false)}
        visible={positionModalOpen}
      />
      <PGNImportModal
        onClose={() => setPgnModalOpen(false)}
        // A bare position is read against this board's mode, which is the one
        // thing a FEN cannot say for itself. See `PGNImportModal`.
        positionMode={mode}
        onLoad={(pgn) => {
          // Parsed here so an unreadable record fails in the modal rather than
          // on the next page.
          const source = reviewSourceFromPGN(pgn, modes);
          // A record with no moves in it is a position rather than a game —
          // which is exactly what COPY POSITION writes — and a game review of
          // one would be an empty score sheet and an accuracy nobody played
          // for. It belongs on the board that is already open behind this
          // modal, which is the board somebody pasting it into *this* screen is
          // looking at.
          const position = source.moves.length === 0 ? source.positions[0] : null;
          if (position) {
            if (position.mode.id !== mode.id) {
              throw new Error(
                `This position is a ${source.mode.name} board. Open the ${source.mode.name} analysis board to paste it.`,
              );
            }
            startFromPosition({
              currentTurn: position.currentTurn,
              era: position.era,
              grid: position.grid,
            });
            setPgnModalOpen(false);
            return;
          }
          setPgnModalOpen(false);
          handReview({ pgn, playerColor: null });
          go(links.review());
        }}
        visible={pgnModalOpen}
      />
    </SafeAreaView>
  );
}

const styles = themedSheet(() => ({
  safeArea: { flex: 1, backgroundColor: colors.background },
  screen: {
    flex: 1,
    width: '100%',
    maxWidth: SCREEN_WIDTH,
    alignSelf: 'center',
    paddingHorizontal: 12,
    paddingBottom: 10,
  },
  // Wraps. Four buttons, a title and the way out do not fit across a narrow
  // window, and the row used to resolve that by squeezing the title to nothing
  // — the mode name was invisible at 390 long before the back button was added
  // beside it. On a second line they all keep their size. A phone has only
  // LOAD PGN up here, so it is one row there unless the text is very large.
  topBar: {
    minHeight: 64,
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    columnGap: 10,
    rowGap: 8,
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    marginBottom: 12,
  },
  titleCopy: { flex: 1, flexBasis: 140, minWidth: 0 },
  kicker: { color: colors.textFaint, fontSize: 8, fontWeight: '900', letterSpacing: 1.35 },
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
  headerActions: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 5 },
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
  disabledCard: {
    maxWidth: 560,
    width: '100%',
    alignSelf: 'center',
    gap: 12,
    marginTop: 40,
    padding: 20,
    borderRadius: radius.large,
    borderWidth: 1,
    borderColor: colors.accentBorder,
    backgroundColor: colors.accentSurface,
  },
  coachCard: {
    padding: 14,
    borderRadius: radius.large,
    borderWidth: 1,
    borderColor: colors.accentBorder,
    backgroundColor: colors.accentSurface,
  },
  cardHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  // The depth sits in the corner, level with the eyebrow, so it reads as a
  // status mark rather than as part of the title. Held to the chip's height
  // whether or not there is a chip, so turning the engine on moves nothing.
  coachHeader: {
    minHeight: 20,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
  },
  coachTitleRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'space-between',
    columnGap: 10,
    rowGap: 8,
    marginTop: 2,
  },
  cardEyebrow: { color: colors.textFaint, fontSize: 8, fontWeight: '900', letterSpacing: 1.2 },
  cardTitle: { color: colors.textStrong, fontSize: 17, fontWeight: '900', marginTop: 5 },
  cardBody: { color: colors.accentSoft, fontSize: 10, lineHeight: 15, marginTop: 8 },
  // A fixed height, so the spinner coming and going never moves the card.
  depthChip: {
    height: 20,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    flexShrink: 0,
  },
  depthSpinner: { transform: [{ scale: 0.7 }], width: 16, height: 16 },
  depthText: {
    color: colors.textMuted,
    fontSize: 8,
    fontWeight: '900',
    letterSpacing: 0.6,
    fontVariant: ['tabular-nums'],
  },
  historyMeta: { color: colors.textFaint, fontSize: 7, fontWeight: '900', letterSpacing: 0.6 },
  switchRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 6,
    marginLeft: 'auto',
  },
  // The same chip as `EngineSwitch`, which sits first in the row.
  switchChip: {
    minHeight: 30,
    justifyContent: 'center',
    paddingHorizontal: 9,
    borderRadius: radius.small,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    backgroundColor: colors.surface,
  },
  // On is neutral, like every other selected state: the accent is for pressing.
  switchChipActive: { borderColor: colors.borderLight, backgroundColor: colors.surfaceMuted },
  switchChipText: { color: colors.textMuted, fontSize: 7, fontWeight: '900' },
  switchChipTextActive: { color: colors.textStrong },
  bestMoveButton: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginTop: 12,
    paddingHorizontal: 14,
    borderRadius: radius.medium,
    backgroundColor: colors.accent,
  },
  bestMoveButtonDisabled: { opacity: 0.4 },
  bestMoveButtonText: { color: colors.textStrong, fontSize: 11, fontWeight: '900' },
  bestMoveButtonDetail: {
    flex: 1,
    minWidth: 0,
    textAlign: 'right',
    color: colors.textStrong,
    fontSize: 11,
    fontWeight: '800',
    fontVariant: ['tabular-nums'],
  },
  bestMoveButtonArrow: { color: colors.textStrong, fontSize: 18, fontWeight: '900' },
  // Rows of equal cells. A cell is a column, so the button in it stretches to
  // the cell's width without a width of its own.
  toolGrid: { gap: 8 },
  toolRow: { flexDirection: 'row', gap: 8 },
  toolCell: { flex: 1, minWidth: 0 },
  phoneHistory: { width: '100%', flexDirection: 'row', gap: 8 },
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
  errorBanner: { position: 'absolute', right: 12, bottom: 12, left: 12, padding: 11, borderRadius: radius.medium, backgroundColor: colors.dangerSurface },
  errorText: { color: colors.dangerText, fontSize: 10, fontWeight: '700', textAlign: 'center' },
}));
