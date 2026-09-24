import * as Clipboard from 'expo-clipboard';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import PlayersCard from './PlayersCard';
import { applyAnalysisMove, moveLabel, type AnalysisGame } from '@/engine/analysisGame';
import { interactiveLimits, type AnalysisEffort } from '@/engine/analysisBudget';
import {
  ReviewError,
  expectedScoreCurve,
  formatLoss,
  reviewSourceFromPGN,
  type GradedMove,
  type RecordedMove,
  type ReviewMove,
  type ReviewSource,
} from '@/engine/gameReview';
import { PGNError, formatMove } from '@/engine/pgn';
import type { Analysis } from '@/engine/rpsfish/protocol';
import AccuracyCard from '@/features/analysis/AccuracyCard';
import AnalysisEffortToggle from '@/features/analysis/AnalysisEffortToggle';
import EngineLinesCard from '@/features/analysis/EngineLinesCard';
import EngineSwitch from '@/features/analysis/EngineSwitch';
import EvalBar from '@/features/analysis/EvalBar';
import EvalChart from '@/features/analysis/EvalChart';
import MoveAnalysisList from '@/features/analysis/MoveAnalysisList';
import MoveQualityBadge from '@/features/analysis/MoveQualityBadge';
import ReplayControls from '@/features/analysis/ReplayControls';
import QuietMoveMeter from '@/features/analysis/QuietMoveMeter';
import TerritoryMeter from '@/features/analysis/TerritoryMeter';
import Board from '@/features/board/Board';
import { namedResultLabel } from '@/features/game/resultLabels';
import BoardExportButton from '@/features/board/BoardExportButton';
import { capturedPieces } from '@/features/board/CapturedPieces';
import type { ShareCardInput } from '@/features/board/export/shareCard';
import { usePieceDrag } from '@/features/board/pieceDrag';
import SeriesLink from '@/features/bots/SeriesLink';
import { seriesContains } from '@/features/bots/seriesSummary';
import SeriesScoreTable from '@/features/bots/SeriesScoreTable';
import GameChat from '@/features/game/GameChat';
import GameTransition from '@/features/game/GameTransition';
import { failureMessage } from '@/errors';
import { useBoardLayout } from '@/hooks/useBoardLayout';
import { useBoardSelection } from '@/hooks/useBoardSelection';
import { useSeriesForGame } from '@/hooks/useBotSeries';
import useGameAnalysis from '@/hooks/useGameAnalysis';
import { usePositionAnalysis } from '@/hooks/usePositionAnalysis';
import useReplayKeyboard from '@/hooks/useReplayKeyboard';
import { useReplayCursor } from '@/hooks/useReplayCursor';
import { useWatchGame } from '@/hooks/useWatchGame';
import { gameReviewURL, links } from '@/navigation/links';
import { up } from '@/navigation/upFrom';
import { isGameLive } from '@/store/spectateSelectors';
import { getGamePGN, putGameAccuracy } from '@/store/api/review';
import { chatRoomScopeOf } from '@/store/chatSelectors';
import { toggleEngineAnalysis, useEngineAnalysis } from '@/store/enginePreference';
import { useGameStore } from '@/store/gameStore';
import { useReviewHandoff } from '@/store/reviewHandoff';
import { colors, players, radius, space, themedSheet } from '@/theme';
import BackLink from '@/ui/BackLink';
import KeyboardLift from '@/ui/KeyboardLift';
import PlayerLink from '@/ui/PlayerLink';
import {
  SIDE_COLORS,
  sameMove,
  type Move,
  type Position,
  type SideColor,
} from '@/types/game';

// A stable empty line, so the analysis hook is not handed a new array on every
// render while the record is still loading.
// The evaluation bar's width plus the gap beside it, so the series strip spans
// the board *and* the bar rather than stopping short of it. Kept next to the
// style that lays those two out (`boardWithEval`), which is its other half.
const EVAL_BAR_GUTTER = 38;

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
    return `At depth ${move.depth} every other move the engine could see was a mistake.`;
  }
  if (move.isTopMove) return `The engine's own choice at depth ${move.depth}.`;
  const best = move.bestMove ? moveLabel(move.bestMove) : 'unavailable';
  if (move.lossPercent < 0.05) return `As strong as the engine's ${best}.`;
  return `Best was ${best} at depth ${move.depth} · ${formatLoss(
    move.lossPercent,
  )} of expected score given up.`;
};

/**
 * The line under GAME RECORD when nothing has been copied yet.
 *
 * A stored game has an address; a bot game or a pasted record does not, so the
 * card must not offer a link there is nothing behind. A game that belongs to a
 * run has a second address — the run itself — and says so, because the link
 * somebody was handed is to one game of six and nothing else on the page would
 * tell them the other five are one press away.
 */
const recordCardHint = (options: { shareable: boolean; inSeries: boolean }) => {
  if (!options.shareable) return "Copy the game to save or review it later.";
  return options.inSeries
    ? "Share this game or view its series."
    : "Share the review link or copy the PGN to save it.";
};

/** The same line once a button has been pressed, for whichever button it was. */
const copiedMessage = (copied: { what: 'pgn' | 'link'; ok: boolean }) => {
  if (copied.what === 'link') {
    return copied.ok
      // Not "graded the same way" any more: whether the engine runs at all is
      // the reader's own choice, on their own device.
      ? "Game link copied."
      : 'The link could not be copied.';
  }
  return copied.ok ? 'PGN copied to your clipboard.' : 'The PGN could not be copied.';
};

/**
 * How long the player sat on this move, as the record kept it.
 *
 * `null` for a move nobody was on a clock for — an untimed game, or a line the
 * reviewer played themselves.
 */
const thinkingTime = (elapsedMs: number | null) => {
  if (elapsedMs === null || elapsedMs < 0) return null;
  if (elapsedMs < 1000) return `${elapsedMs}ms`;
  if (elapsedMs < 60_000) return `${(elapsedMs / 1000).toFixed(1)}s`;
  const minutes = Math.floor(elapsedMs / 60_000);
  return `${minutes}m ${Math.round((elapsedMs % 60_000) / 1000)}s`;
};

interface CurrentMoveCardProps {
  analysis: Analysis | null;
  /**
   * Whether this move is being graded at all.
   *
   * Off, the card is the record's account of the move and nothing else: what
   * was played, by whom, and how long they spent on it. That last is the one
   * thing a review can say about a move without an engine, and it is worth
   * saying — a blunder played in half a second and one played after two
   * minutes are different mistakes.
   */
  graded: boolean;
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

function CurrentMoveCard({ analysis, graded, move, onPlayBest, thinking }: CurrentMoveCardProps) {
  // Offered only when there was something better: a move that gave up nothing
  // has no alternative worth trying.
  const bestMove = graded && move && !move.pending && !move.isTopMove ? move.bestMove : null;
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

  const spent = thinkingTime(move.elapsedMs);

  return (
    <View style={styles.currentCard}>
      <View style={styles.currentTop}>
        <View style={styles.currentCopy}>
          <Text style={styles.cardEyebrow}>
            MOVE {move.index + 1} · {move.player.toUpperCase()}
          </Text>
          <Text style={styles.currentMove}>{formatMove(move)}</Text>
        </View>
        {!graded ? null : move.pending ? (
          <ActivityIndicator color={colors.textMuted} size="small" />
        ) : (
          <MoveQualityBadge grade={move.grade} />
        )}
      </View>
      {!graded ? (
        <Text style={styles.currentDetail}>
          {spent ? `${move.player} spent ${spent} on it. ` : ''}
          Play a move on the board to try your own line from here.
        </Text>
      ) : move.pending ? (
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
      {graded && thinking && !analysis ? (
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
  const draggingPiece = usePieceDrag((state) => state.dragging);

  // Chat is a property of the live session, not of the review: staying on the
  // same finished game means the room the players are already in stays open
  // while they look at the board together.
  const liveGameId = useGameStore((state) => state.gameState?.gameId ?? null);
  const liveGames = useGameStore((state) => state.liveGames);
  // Joined once rather than mapped in the render, so the table is not handed a
  // fresh array on every tick of the lobby.
  const liveGameIds = useMemo(() => liveGames.map((live) => live.gameId), [liveGames]);
  const watchGame = useWatchGame();
  const chatMessages = useGameStore((state) => state.chatMessages);
  const chatRoomId = useGameStore((state) => state.chatRoomId);
  const chatRoomScope = useGameStore((state) => state.chatRoomScope);
  const chatOccupancy = useGameStore((state) => state.chatOccupancy);
  const chatVisible = useGameStore((state) => state.chatVisible);
  const showSpectatorMessages = useGameStore((state) => state.showSpectatorMessages);
  const isSpectating = useGameStore((state) => state.isSpectating);
  const connectionStatus = useGameStore((state) => state.connectionStatus);
  const sendChat = useGameStore((state) => state.sendChat);
  const toggleChat = useGameStore((state) => state.toggleChat);
  const toggleSpectatorMessages = useGameStore((state) => state.toggleSpectatorMessages);

  const [pgnText, setPgnText] = useState<string | null>(providedPGN);
  const [loadError, setLoadError] = useState<string | null>(null);
  // The run this game is one game of, when it is one. Asked by game id rather
  // than carried on the link, so a pasted URL gets the strip too — and asked
  // through the same hook the spectate rail uses, so the two screens cannot end
  // up with two ideas of what a failed lookup looks like. A game that is not
  // part of a run simply answers nothing, and none of this appears.
  const { series } = useSeriesForGame(gameId);
  // Where the back button goes.
  //
  // A game of a run belongs under that run: six games between two engines are
  // one thing that happened, and somebody who walked in from the series page —
  // or from a link to a game of it — is going back to the run rather than to
  // the lobby. Everything else is a game on its own and goes to the lobby,
  // which is where the archive is read from.
  //
  // Derived from the record rather than from history, which is what makes it
  // the same answer on a refresh and on a pasted link. `router.back()` used to
  // do this job and got it wrong in the ordinary case: a review reached from a
  // watched game that had just finished sat on top of that game's `/watch`
  // entry, so "back" put the reader on a board that no longer existed, which
  // forwarded straight back to this review.
  const upTarget = series ? { label: 'Series', href: links.series(series.seriesId) } : up.review;
  // The game asked for while the one on screen is still up, which is what drives
  // the board's hand-off. Cleared when the new record lands. See GameTransition:
  // this is the same animation the spectate screen plays when a series moves on
  // to its next board, because it is the same act.
  const [switchingTo, setSwitchingTo] = useState<string | null>(null);
  // Whether RPSFish is asked about this game at all. A device preference, not
  // screen state, and it ships off — see `store/enginePreference.ts`. Off, this
  // page is the game and the reader; on, it is the graded review it used to be.
  const engineOn = useEngineAnalysis();
  const [effort, setEffort] = useState<AnalysisEffort>('full');
  const [branch, setBranch] = useState<ReviewBranch | null>(null);
  // Which of the two things this card copies was last copied, and whether the
  // clipboard took it. One piece of state rather than two, because the line of
  // text under the eyebrow reports for both buttons and only ever says one
  // thing.
  const [copyState, setCopyState] = useState<{
    what: 'pgn' | 'link';
    ok: boolean;
  } | null>(null);
  const [widePanelHeight, setWidePanelHeight] = useState<number | null>(null);
  // How much room the run's table over the board is taking, so the board can
  // give it up rather than pushing what is under it off the screen.
  const [seriesTableHeight, setSeriesTableHeight] = useState(0);
  // The key of the accuracy already reported, so it is reported once.
  const savedRef = useRef<string | null>(null);

  // The record on screen, and the id it came from. Held together so that a
  // change of game id is known to be a change rather than inferred: this screen
  // used to keep the first PGN it was given for as long as it was mounted, which
  // was invisible while every game arrived on its own page and became a bug the
  // moment one screen could show a second game.
  const loadedRef = useRef<string | null>(gameId ?? null);
  useEffect(() => {
    if (!gameId) return undefined;
    if (pgnText && loadedRef.current === gameId) return undefined;
    let cancelled = false;
    getGamePGN(gameId)
      .then((text) => {
        if (cancelled) return;
        loadedRef.current = gameId;
        setLoadError(null);
        setPgnText(text);
        setSwitchingTo(null);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setSwitchingTo(null);
        setLoadError(failureMessage(error, 'The record could not be loaded.'));
      });
    return () => {
      cancelled = true;
    };
  }, [gameId, pgnText]);

  // Stepping to another game of the same run.
  //
  // A game still being played is watched rather than read back: it has no
  // archived record yet, so reviewing it lands on "this game cannot be
  // reviewed", and the thing somebody clicking the live column wants is
  // obviously the board.
  //
  // For a finished one, `replace` rather than `push`, so that walking a
  // six-game series does not leave six entries to back out of; the PGN is
  // dropped here so the effect above fetches the new one.
  const watchSeriesGame = useCallback(
    (nextGameId: string) => {
      if (!nextGameId || nextGameId === gameId) return;
      if (isGameLive(liveGames, nextGameId)) {
        watchGame(nextGameId);
        return;
      }
      setSwitchingTo(nextGameId);
      setPgnText(null);
      setBranch(null);
      router.replace(links.review(nextGameId));
    },
    [gameId, liveGames, router, watchGame],
  );

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
  //
  // Off unless the reviewer has asked for it. With the engine off the hook
  // still builds a report — every move ungraded — which is exactly the score
  // sheet a manual review wants: the moves that were played, steppable, with
  // nothing claimed about them.
  const gameAnalysis = useGameAnalysis({
    bookPlies: record?.bookPlies ?? 0,
    enabled: engineOn,
    mode: record?.mode,
    moves: record?.moves ?? EMPTY_MOVES,
    positions: record?.positions ?? EMPTY_POSITIONS,
    effort,
  });
  const entries = gameAnalysis.entries;
  const report = gameAnalysis.report;
  const reviewState = gameAnalysis.status;
  const engineLimits = gameAnalysis.limits;

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
    limits: interactiveLimits({ effort }),
    enabled: !onMainLine && engineOn,
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

  // Store the accuracy once per depth, and only once the whole game has been
  // graded: an average over the moves reviewed so far is not anybody's
  // accuracy. Once per depth rather than once, because the walk deepens on its
  // own — the accuracy from the first shallow pass is a real number worth
  // keeping if the reviewer leaves immediately, and each deeper pass that
  // completes is a better one that should replace it. The server takes the last
  // report it is sent, so a deeper review corrects a shallower one.
  useEffect(() => {
    const viewerColor: SideColor | null = record
      ? (SIDE_COLORS.find((color) => record.players[color]?.userId === accountId) ?? null)
      : null;
    // `report.complete` is already false with the engine off, since nothing was
    // graded. Said again here because this writes to the archive: a review that
    // measured nothing must never overwrite a number an earlier one measured.
    if (!engineOn || !record || !report?.complete || !gameId || !viewerColor) return;
    const measured = report.accuracy[viewerColor];
    if (!measured) return;
    const key = `${gameId}:${viewerColor}:${engineLimits.maxDepth}`;
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
      // The budget the report was actually graded at, read off the walk rather
      // than off a setting: nobody chooses a depth any more, so a stored
      // number's provenance is whatever rung the walk had reached when it was
      // stored.
      engine: {
        effort,
        maxDepth: engineLimits.maxDepth,
        maxNodes: engineLimits.maxNodes,
        maxTimeMs: engineLimits.maxTimeMs,
        variations: engineLimits.variations,
      },
    })
      .then(() => {})
      // A review the archive would not take is not worth interrupting the
      // reviewer over: the numbers on screen are the same either way.
      .catch(() => {});
  }, [accountId, effort, engineLimits, engineOn, gameId, profileKey, record, report]);

  // Chat lives under the board on a wide screen, so the board leaves room for
  // it rather than pushing it off the bottom.
  //
  // Shown for any game of the run, not only the one the socket is seated on.
  // Every game of a bot series shares one room — that is the whole point of the
  // room outliving its board — so stepping back to game two of six to look at
  // something is not leaving the conversation, and hiding the chat there would
  // make it look like it was.
  const showChat =
    Boolean(liveGameId) && (liveGameId === gameId || seriesContains(series, liveGameId));
  // The run's table sits above the board and is measured rather than guessed:
  // it is two rows and a header, plus a line for every game somebody walked away
  // from, so its height is not a constant. Without this the board keeps the room
  // it had before there was a table over it and the chat underneath is pushed
  // off the bottom of the window.
  const { boardSize, isWide } = useBoardLayout({
    sidePanel: 440,
    below: (showChat ? 240 : 0) + seriesTableHeight,
  });

  if (loadError && !record) {
    return (
      <SafeAreaView style={styles.safeArea} edges={['top', 'right', 'bottom', 'left']}>
        <View style={styles.centered}>
          <Text style={styles.emptyTitle}>This game cannot be reviewed</Text>
          <Text style={styles.emptyBody}>{loadError}</Text>
          <BackLink href={upTarget.href} label={upTarget.label} />
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
          <BackLink href={upTarget.href} label={upTarget.label} />
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
  // The board as the export dialog needs it. The clocks are the record's own —
  // what each side had left after the move being looked at, not what they
  // finished with — so a picture of move fourteen is a picture of move
  // fourteen, clocks included.
  const captureTrays = capturedPieces({ grid: game.grid, mode: record.mode });
  const exportBoard: ShareCardInput = {
    grid: game.grid,
    currentTurn: game.currentTurn,
    mode: record.mode,
    era: record.era,
    flipped: viewerColor === 'Red',
    lastMove: lastMoveShown ? { from: lastMoveShown.from, to: lastMoveShown.to } : null,
    detail: {
      players: {
        Red: {
          name: record.players.Red.name || 'Red',
          detail: record.players.Red.elo ? String(record.players.Red.elo) : undefined,
        },
        Blue: {
          name: record.players.Blue.name || 'Blue',
          detail: record.players.Blue.elo ? String(record.players.Blue.elo) : undefined,
        },
      },
      clock:
        lastMoveShown?.redRemainingMs !== null &&
        lastMoveShown?.redRemainingMs !== undefined &&
        lastMoveShown?.blueRemainingMs !== null &&
        lastMoveShown?.blueRemainingMs !== undefined
          ? { Red: lastMoveShown.redRemainingMs, Blue: lastMoveShown.blueRemainingMs }
          : null,
      captured: { Red: captureTrays.Red.tally, Blue: captureTrays.Blue.tally },
      heading: record.event || undefined,
      caption:
        cursor >= record.moves.length && record.endReason
          ? namedResultLabel({
              redName: record.players.Red.name || 'Red',
              blueName: record.players.Blue.name || 'Blue',
              winnerName:
                record.winner === 'Neutral'
                  ? null
                  : record.players[record.winner].name || record.winner,
              endReason: record.endReason,
            })
          : `Move ${cursor} · ${game.currentTurn} to move`,
    },
  };
  const chartPoints = expectedScoreCurve(report.evaluations, record.mode.id);
  // How far the walk has got, as one number for the header. A first pass counts
  // positions graded; a deeper pass counts positions regraded, because by then
  // every move already has a grade and what is left to wait for is the better
  // one.
  const refining = gameAnalysis.refining;
  const progress = refining
    ? Math.round((refining.done / Math.max(1, refining.total)) * 100)
    : Math.round((report.analyzed / Math.max(1, report.total)) * 100);
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
      roomOccupancy={chatOccupancy}
      scope={chatRoomScopeOf(chatRoomScope, chatRoomId, liveGameId)}
      showSpectatorMessages={showSpectatorMessages}
      spectatorCount={0}
      wide={false}
    />
  ) : null;

  // The engine switch always, and how hard it is thinking only while it is
  // thinking: a depth readout beside a switch that is off describes a search
  // nobody asked for.
  const engineControls = (
    <View style={styles.engineControls}>
      <EngineSwitch
        enabled={engineOn}
        offDetail="MANUAL REVIEW"
        onToggle={toggleEngineAnalysis}
      />
      {engineOn ? (
        <AnalysisEffortToggle
          deeperToCome={gameAnalysis.deeperToCome}
          depth={gameAnalysis.depth}
          onToggleQuick={() => setEffort((current) => (current === 'quick' ? 'full' : 'quick'))}
          quick={effort === 'quick'}
          refining={gameAnalysis.refining}
        />
      ) : null}
    </View>
  );

  const boardBlock = (
    <View style={styles.boardStack}>
      {series ? (
        <View
          onLayout={(event) => {
            // Rounded up to a step, and only ever grown by a step, because the
            // measurement feeds the board size that feeds this width: a strip
            // whose wrapping changed by a pixel could otherwise chase the board
            // back and forth for ever.
            const measured = Math.ceil(event.nativeEvent.layout.height / 8) * 8;
            setSeriesTableHeight((current) => (current === measured ? current : measured));
          }}
          style={[
            styles.seriesStrip,
            { maxWidth: boardSize + (engineOn ? EVAL_BAR_GUTTER : 0) },
          ]}
        >
          <SeriesScoreTable
            compact
            currentGameId={gameId ?? null}
            liveGameIds={liveGameIds}
            onSelect={watchSeriesGame}
            series={series}
          />
        </View>
      ) : null}
      <GameTransition gameKey={gameId ?? null} leaving={Boolean(switchingTo)}>
    <View style={styles.boardWithEval}>
      {/*
        The bar, the arrows and the grade on the last square are all the engine
        talking. With it off the board is the board: the game replayed, the last
        move highlighted, and nothing drawn over it that somebody has to decide
        whether to believe.
      */}
      {engineOn ? <EvalBar height={boardSize} redScore={analysis?.redScore} /> : null}
      <Board
        analysisArrows={engineOn ? analysis?.lines ?? [] : []}
        boardSize={boardSize}
        canMove={game.status === 'InProgress'}
        grid={game.grid}
        lastMove={lastMoveShown ? { from: lastMoveShown.from, to: lastMoveShown.to } : null}
        lastMoveGrade={engineOn && onMainLine && !currentMove?.pending ? currentMove?.grade : null}
        modeId={record.mode.id}
        era={record.era}
        movableColor={game.currentTurn}
        onPieceDrop={playMove}
        onTilePress={selection.selectTile}
        playerColor={viewerColor === 'Red' ? 'Red' : 'Blue'}
        replayIndex={cursor}
        replayPositions={positionsInView}
        selectedTile={selectedTile}
        validMoves={validMoves}
      />
    </View>
      </GameTransition>
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

      {/*
        Above the record card, because who played is read before how to keep
        the game: this is the first thing the panel says about the record, and
        it is one of the two the header has no room for.
      */}
      <PlayersCard
        players={record.players}
        ranked={record.ranked}
        ratingSystem={record.ratingSystem}
        viewerColor={viewerColor}
      />

      <View style={styles.recordCard}>
        <View style={styles.recordCopy}>
          <Text style={styles.cardEyebrow}>GAME RECORD</Text>
          <Text accessibilityLiveRegion="polite" style={styles.recordDetail}>
            {copyState
              ? copiedMessage(copyState)
              : recordCardHint({ inSeries: Boolean(series), shareable: Boolean(gameId) })}
          </Text>
        </View>
        <View style={[styles.recordActions, isWide && styles.recordActionsWide]}>
          {/*
            Only for a game the server has: a bot game or a pasted record is
            here through the handoff store and has no address anybody else
            could open, so there is nothing to hand over but the text.
          */}
          {gameId ? (
            <Pressable
              accessibilityLabel="Copy a link to this game review"
              accessibilityRole="button"
              onPress={async () => {
                try {
                  await Clipboard.setStringAsync(gameReviewURL(gameId));
                  setCopyState({ what: 'link', ok: true });
                } catch {
                  setCopyState({ what: 'link', ok: false });
                }
              }}
              style={({ pressed }) => [styles.copyButton, pressed && styles.pressed]}
            >
              <Text style={styles.copyButtonText}>
                {copyState?.what === 'link' && copyState.ok ? 'COPIED ✓' : 'COPY GAME LINK'}
              </Text>
            </Pressable>
          ) : null}
          <Pressable
            accessibilityLabel="Copy game PGN"
            accessibilityRole="button"
            onPress={async () => {
              try {
                await Clipboard.setStringAsync(record.pgn);
                setCopyState({ what: 'pgn', ok: true });
              } catch {
                setCopyState({ what: 'pgn', ok: false });
              }
            }}
            style={({ pressed }) => [styles.copyButton, pressed && styles.pressed]}
          >
            <Text style={styles.copyButtonText}>
              {copyState?.what === 'pgn' && copyState.ok ? 'COPIED ✓' : 'COPY PGN'}
            </Text>
          </Pressable>
          {/*
            The way out to the whole run, for the person this link was sent to.
            The strip over the board already lets them step between the games;
            this is the other question — how the *match* went — and it is here
            rather than up there because the board should not pay a line of
            height for it.
          */}
          {series ? <SeriesLink label="SERIES RESULTS ›" seriesId={series.seriesId} /> : null}
        </View>
      </View>

      {/*
        Accuracy and the evaluation curve are the two things a review is
        usually opened for, and both are the engine's claim rather than the
        record's. With it off they are absent rather than empty: a chart with
        no line in it and a card reading "—%" would be an unfinished review,
        which is not what this is.
      */}
      {engineOn ? (
        <AccuracyCard
          accuracy={report.accuracy}
          pendingDetail={
            gameAnalysis.error ? 'The review stopped before it could finish.' : 'Still reviewing…'
          }
          players={record.players}
          viewerColor={viewerColor}
        />
      ) : null}

      {isWide ? null : chat}

      {engineOn ? (
        <EvalChart
          currentIndex={mainLineIndex}
          moves={report.moves}
          onSelect={goTo}
          points={chartPoints}
          total={record.positions.length}
        />
      ) : null}

      {/*
        Both read the board rather than the engine — how the territory stands
        and how close the position is to the quiet-move draw — so both survive
        the engine being off, and they are most of what a manual review has to
        look at besides the pieces.
      */}
      {record.mode.features?.includes('territory') ? <TerritoryMeter grid={game.grid} /> : null}
      <QuietMoveMeter game={game} />

      {onMainLine ? (
        <CurrentMoveCard
          analysis={analysis}
          graded={engineOn}
          thinking={reviewState === 'running'}
          move={currentMove}
          onPlayBest={(best) => playInstead(mainLineIndex - 1, best)}
        />
      ) : null}

      {engineOn ? <EngineLinesCard analysis={analysis} turn={game.currentTurn} /> : null}

      <MoveAnalysisList
        graded={engineOn}
        moves={report.moves}
        onSelect={goTo}
        selectedIndex={mainLineIndex}
        // The board as it stands, not the game's final one: a review is read by
        // stepping through it, and the position worth taking away is whichever
        // one stopped you — including one off the record, down a line of your
        // own. COPY PGN on the card above is the other half of that pair and
        // hands over the whole game.
        titleAccessory={<BoardExportButton board={exportBoard} />}
      />
    </View>
  );

  return (
    <SafeAreaView style={styles.safeArea} edges={['top', 'right', 'bottom', 'left']}>
      <View style={styles.screen}>
        <View style={styles.topBar}>
          <View style={styles.topBarRow}>
            <BackLink href={upTarget.href} label={upTarget.label} />
            <View style={styles.titleCopy}>
              <Text numberOfLines={1} style={styles.kicker}>
                {record.mode.shortCode ?? record.mode.id} · GAME REVIEW ·{' '}
                {reviewState === 'running'
                  ? `${progress}%`
                  : reviewState === 'deepening'
                    ? `DEPTH ${refining?.limits.maxDepth ?? gameAnalysis.depth} · ${progress}%`
                    : record.result}
              </Text>
              {/*
                Both names lead to their pages. This is the screen the game just
                ended on, which is exactly when "who was that" is worth asking —
                and unlike the board, there is nobody left waiting on a move.
                Addressed by user id where the record has one, since a name off
                a pasted PGN is whatever the file said.

                Each name is prefixed by the side that played it, because this
                is the one line naming both players that is on the screen in
                every layout and with the engine off — and without it the whole
                page, the result token above included, talks about two colours
                it never attaches to anybody. Set in the side's own colour and
                spelled out as well, so it does not rest on the colour alone;
                small, because the names are what this line is for. `PLAYERS`
                below carries the same pairing at full size along with what the
                two were rated.

                Nested inside the one `Text` rather than laid out as a row of
                pieces: this is a sentence, and a flex row wraps it in the
                wrong places.

                And allowed to wrap, where it used to be cut off at one line.
                The tags cost about five characters a side and a phone header
                has no five characters spare: `ProfessorLongstocking vs
                AnotherVeryLongBotName` was already being cut short at 390
                points, and with the tags in front of it the cut landed before
                `BLUE`, which took the second player off the header altogether.
                A `numberOfLines` of two is not the fix — react-native-web
                clamps with `-webkit-line-clamp`, so a name that will not fit
                on the second line is replaced by the ellipsis rather than
                broken across a third — and this line is the one place both
                players are named in every layout, so losing one of them is the
                one outcome not worth trading for.

                It only wraps when it would otherwise have been truncated: an
                ordinary matchup still sits on one line at every width, and a
                wrap costs a line of header only on a phone, whose board is
                inside a scroller and does not pay for it.
              */}
              <Text style={styles.title}>
                <Text style={[styles.sideTag, styles.redTag]}>RED </Text>
                <PlayerLink
                  handle={record.players.Red?.userId || record.players.Red?.name || ''}
                  name={record.players.Red?.name || 'Red'}
                />
                {' vs '}
                <Text style={[styles.sideTag, styles.blueTag]}>BLUE </Text>
                <PlayerLink
                  handle={record.players.Blue?.userId || record.players.Blue?.name || ''}
                  name={record.players.Blue?.name || 'Blue'}
                />
              </Text>
            </View>
            {/*
              Beside the matchup where there is room for both, and on its own
              line where there is not — this used to be three depth chips, which
              took enough of a phone's header to cut `Henhen1227 vs Guest` down
              to `Henhen1227 v…`, and whose game this is matters more up here
              than how deep it is being read. One chip and a status line is
              narrower than three chips were, but only just, and the status line
              is the part that grows.
            */}
            {isWide ? engineControls : null}
          </View>
          {isWide ? null : <View style={styles.effortRow}>{engineControls}</View>}
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
              {/*
                Lifted over the column when the keyboard is up rather than
                resized under it — the same as the live board's chat, and for
                the same reason: this column is as tall as the board plus its
                controls, and there is no room under them to give a keyboard.
              */}
              {chat ? <KeyboardLift style={styles.chatSlot}>{chat}</KeyboardLift> : null}
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
            // The chat is at the bottom of this page on a phone, so the keyboard
            // is iOS's problem to solve: it pads the content by the room the
            // keyboard takes and brings the focused composer up out from under
            // it. Without this the composer was simply behind the keyboard.
            automaticallyAdjustKeyboardInsets
            contentContainerStyle={styles.mobileContent}
            keyboardShouldPersistTaps="handled"
            // The board is inside this scroller on a phone, and dragging a
            // piece must not drag the page with it.
            scrollEnabled={!draggingPiece}
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

const styles = themedSheet(() => ({
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
  pressed: { opacity: 0.68 },
  topBar: {
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    marginBottom: 12,
  },
  topBarRow: { minHeight: 64, flexDirection: 'row', alignItems: 'center' },
  // Two chips and a status line, shrinking together: on a phone this shares the
  // header with the matchup, and the part that gives way must be the status
  // text rather than the players' names.
  engineControls: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    minWidth: 0,
    flexShrink: 1,
  },
  effortRow: { flexDirection: 'row', justifyContent: 'flex-end', paddingBottom: 8 },
  titleCopy: { flex: 1, minWidth: 0, paddingHorizontal: 10 },
  kicker: { color: colors.accentBright, fontSize: 8, fontWeight: '900', letterSpacing: 1.35 },
  title: { color: colors.textStrong, fontSize: 18, fontWeight: '900', marginTop: 2 },
  // Riding inside the title's line, at the size of an eyebrow rather than of
  // the names: a phone header holds `RED Henhen1227 vs BLUE Guest` at these
  // sizes and would not hold two more words at eighteen points.
  sideTag: { fontSize: 9, fontWeight: '900', letterSpacing: 0.8 },
  redTag: { color: players.Red.strong },
  blueTag: { color: players.Blue.strong },
  wideLayout: { flex: 1, flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'center', gap: 18 },
  boardColumn: { alignItems: 'center', gap: 10 },
  // The chat's slot, which is a wrapper's now rather than the card's own. The
  // column centres its children, so the wrapper has to be told to span it: an
  // auto-width parent has nothing for the card's `width: '100%'` to be a
  // percentage of.
  chatSlot: { alignSelf: 'stretch' },
  boardWithEval: { flexDirection: 'row', alignItems: 'stretch', gap: 7 },
  // The strip sits over the board and no wider than it, so a six-game run reads
  // as belonging to the board underneath rather than to the page.
  boardStack: { gap: space.small },
  seriesStrip: {
    gap: space.snug,
    padding: space.small,
    borderWidth: 1,
    borderColor: colors.borderSoft,
    borderRadius: radius.small,
    backgroundColor: colors.surfaceWell,
  },
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
  // Stacked on a phone, where two buttons side by side would squeeze the line
  // of text beside them into one word per row.
  recordActions: { gap: 6 },
  recordActionsWide: { flexDirection: 'row', alignItems: 'center' },
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
}));
