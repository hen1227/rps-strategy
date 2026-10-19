import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ScrollView, Text, View, type LayoutChangeEvent } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { FIRST_OPPONENT_ID, LESSON_MODE_ID, LESSONS, type Lesson } from './lessons';
import { takeLessonDoor } from './firstGame';
import { track } from '@/analytics/track';
import { createAnalysisGame, predatorOf, preyOf, stepTargets } from '@/engine/analysisGame';
import { botProfile } from '@/engine/bots/profiles';
import { isEngineAvailable } from '@/engine/rpsfish/client';
import Board from '@/features/board/Board';
import { emptyOverlayCells, type BoardOverlay } from '@/features/board/overlay';
import PieceIcon from '@/features/board/PieceIcon';
import { usePieceDrag } from '@/features/board/pieceDrag';
import BotIcon from '@/features/bots/BotIcon';
import { useSolveSession } from '@/features/solve/useSolveSession';
import { useBoardLayout } from '@/hooks/useBoardLayout';
import { up } from '@/navigation/upFrom';
import { useGameStore } from '@/store/gameStore';
import { colors, radius, reach, space, themedSheet, type } from '@/theme';
import BackLink from '@/ui/BackLink';
import { PrimaryButton } from '@/ui/primitives';
import {
  BOARD_SIZE,
  type Grid,
  type ModeDefinition,
  type PlayablePiece,
} from '@/types/game';

// The first game.
//
// Four positions on the real board, one move each, and then a real game against
// the gentlest bot. It is the page a new device is sent to the first time it
// reaches the lobby, and the page How to play hands over to after that.
//
// The board is the whole page. One title says what the position is about and
// one line under it says what to do, then what went wrong, then what was
// learned — the same line, in room kept for the longest of them, so the board
// never moves while somebody is looking at it. NEXT is drawn from the start and
// comes alive once the answer is on the board, rather than appearing and
// pushing the page down.

/** The room the panel beside the board takes on a wide screen, gap included. */
const SIDE_PANEL = 400;

const noop = () => {};

/**
 * Every square one of Red's pieces could take a `prey` on, washed and outlined
 * the way the reach tool marks danger. Recomputed from the board as it stands, so the wash
 * follows the scissors when it moves.
 */
const dangerOverlay = (grid: Grid, prey: PlayablePiece): BoardOverlay => {
  const hunter = predatorOf(prey);
  const cells = emptyOverlayCells(BOARD_SIZE, BOARD_SIZE);
  for (const row of grid) {
    for (const tile of row) {
      if (tile.occupantOwner !== 'Red' || tile.occupant !== hunter) continue;
      for (const { x, y } of stepTargets(grid, { x: tile.x, y: tile.y }, 'Red', hunter)) {
        // Outlined as well as washed: the wash alone reads as olive on the
        // green squares, and the lesson calls them orange.
        cells[y][x] = {
          fill: reach.danger,
          ring: reach.dangerRing,
          describe: `${hunter.toLowerCase()} can reach`,
        };
      }
    }
  }
  return { cells, legend: `Orange: squares their ${hunter.toLowerCase()} can reach` };
};

export default function LearnScreen() {
  const modes = useGameStore((state) => state.modes);
  // The catalogue the store starts with already has the main game in it, so
  // this only comes up empty if a server ever drops the mode altogether.
  const mode = modes.find((candidate) => candidate.id === LESSON_MODE_ID) ?? null;
  const [step, setStep] = useState(0);
  const finished = step >= LESSONS.length;

  // Which door this was, sent once. A ref rather than trusting the effect to
  // run once, because a development build runs every effect twice.
  const begun = useRef(false);
  useEffect(() => {
    if (begun.current) return;
    begun.current = true;
    track('tutorial_begin', { source: takeLessonDoor() });
  }, []);

  const completed = useRef(false);
  const lessonSolved = useCallback((index: number) => {
    if (index !== LESSONS.length - 1 || completed.current) return;
    completed.current = true;
    track('tutorial_complete');
  }, []);

  // Measured, as the analysis board's is: the board grows into the row it
  // shares with the panel and never past the foot of the window.
  const [wideRowHeight, setWideRowHeight] = useState<number | null>(null);
  const onWideRowLayout = useCallback((event: LayoutChangeEvent) => {
    const next = Math.floor(event.nativeEvent.layout.height);
    setWideRowHeight((current) => (current === next ? current : next));
  }, []);
  const { boardSize, isWide } = useBoardLayout({
    sidePanel: SIDE_PANEL,
    maxHeight: wideRowHeight ?? undefined,
    narrowHeightShare: 0.56,
    narrowMargin: space.medium * 2,
  });

  const lesson = LESSONS[step];

  return (
    <SafeAreaView style={styles.safeArea} edges={['top', 'right', 'bottom', 'left']}>
      <View style={styles.screen}>
        <View style={styles.topBar}>
          <BackLink href={up.learn.href} label={up.learn.label} />
          <View style={styles.titleCopy}>
            <Text numberOfLines={1} style={styles.kicker}>
              {(mode?.name ?? 'Intransitive').toUpperCase()}
            </Text>
            <Text numberOfLines={1} style={styles.title}>
              Learn to play
            </Text>
          </View>
          {/* A wide screen lists the lessons beside the board instead. */}
          {isWide ? null : <Progress done={step} total={LESSONS.length} />}
        </View>

        {!mode ? null : finished || !lesson ? (
          <Finale
            boardSize={boardSize}
            done={step}
            isWide={isWide}
            mode={mode}
            onWideRowLayout={onWideRowLayout}
          />
        ) : (
          <LessonStep
            boardSize={boardSize}
            done={step}
            isWide={isWide}
            key={lesson.id}
            last={step === LESSONS.length - 1}
            lesson={lesson}
            mode={mode}
            onNext={() => setStep((current) => current + 1)}
            onSolved={() => lessonSolved(step)}
            onWideRowLayout={onWideRowLayout}
          />
        )}
      </View>
    </SafeAreaView>
  );
}

/**
 * How far through, as a row of dots in the corner: a mark rather than a
 * sentence, and one that never changes size.
 */
function Progress({ done, total }: { done: number; total: number }) {
  const label = done >= total ? 'All lessons done' : `Lesson ${done + 1} of ${total}`;
  return (
    <View accessibilityLabel={label} accessible style={styles.progress}>
      {Array.from({ length: total }, (_unused, index) => (
        <View
          key={index}
          style={[
            styles.progressDot,
            index < done && styles.progressDotDone,
            index === done && styles.progressDotCurrent,
          ]}
        />
      ))}
    </View>
  );
}

/** The cycle, in the order it is said: each one's prey is the next one's hunter. */
const MATCHUPS = (['Rock', 'Scissors', 'Paper'] as const).map((winner) => ({
  winner,
  loser: preyOf(winner),
}));

/** The rule every lesson turns on, kept in view while the lessons are played. */
function WhatBeatsWhat() {
  return (
    <View style={styles.reference}>
      <Text style={styles.sectionLabel}>WHAT BEATS WHAT</Text>
      <View style={styles.matchups}>
        {MATCHUPS.map(({ winner, loser }) => (
          <View
            accessibilityLabel={`${winner} beats ${loser}`}
            accessible
            key={winner}
            style={styles.matchup}
          >
            <PieceIcon color="Blue" piece={winner} size={22} />
            <Text style={styles.beats}>beats</Text>
            <PieceIcon color="Red" piece={loser} size={22} />
          </View>
        ))}
      </View>
    </View>
  );
}

/** Every lesson by name, for a wide screen: where you are and what is left. */
function LessonList({ done }: { done: number }) {
  return (
    <View style={styles.reference}>
      <Text style={styles.sectionLabel}>LESSONS</Text>
      {LESSONS.map((lesson, index) => {
        const finished = index < done;
        const current = index === done;
        return (
          <View key={lesson.id} style={[styles.lessonRow, current && styles.lessonRowCurrent]}>
            <Text style={[styles.lessonNumber, current && styles.lessonTextCurrent]}>
              {finished ? '✓' : index + 1}
            </Text>
            <Text
              numberOfLines={1}
              style={[styles.lessonName, current && styles.lessonTextCurrent]}
            >
              {lesson.title}
            </Text>
          </View>
        );
      })}
    </View>
  );
}

interface StepLayoutProps {
  boardSize: number;
  /** Lessons answered so far. */
  done: number;
  isWide: boolean;
  onWideRowLayout: (event: LayoutChangeEvent) => void;
}

/**
 * The board, the words about it and the one button, in the two shapes the page
 * takes: side by side on a wide screen, stacked and scrolling on a phone.
 */
function StepLayout({
  board,
  boardSize,
  button,
  copy,
  done,
  isWide,
  onWideRowLayout,
}: StepLayoutProps & { board: ReactNode; button: ReactNode; copy: ReactNode }) {
  // The board is inside the scroller on a phone, and dragging a piece must not
  // drag the page with it.
  const dragging = usePieceDrag((state) => state.dragging);
  if (isWide) {
    return (
      <View onLayout={onWideRowLayout} style={styles.wideLayout}>
        <View style={{ width: boardSize }}>{board}</View>
        <View style={styles.widePanel}>
          {copy}
          {button}
          <WhatBeatsWhat />
          <LessonList done={done} />
        </View>
      </View>
    );
  }
  return (
    <ScrollView
      contentContainerStyle={styles.phoneContent}
      scrollEnabled={!dragging}
      showsVerticalScrollIndicator={false}
    >
      {copy}
      {board}
      <View style={[styles.phoneButton, { width: boardSize }]}>{button}</View>
      <View style={{ width: boardSize }}>
        <WhatBeatsWhat />
      </View>
    </ScrollView>
  );
}

function LessonStep({
  last,
  lesson,
  mode,
  onNext,
  onSolved,
  ...layout
}: StepLayoutProps & {
  last: boolean;
  lesson: Lesson;
  mode: ModeDefinition;
  onNext: () => void;
  onSolved: () => void;
}) {
  const session = useSolveSession({ mode, position: lesson, onSolved });
  const solved = session.state === 'solved';
  const missed = !solved && session.misses > 0;
  const line = solved ? lesson.success : missed ? lesson.hint : lesson.prompt;
  const grid = session.game.grid;
  const overlay = useMemo(
    () => (lesson.danger ? dangerOverlay(grid, lesson.danger) : null),
    [grid, lesson.danger],
  );

  return (
    <StepLayout
      {...layout}
      board={
        <Board
          boardSize={layout.boardSize}
          canMove={session.state === 'waiting'}
          grid={session.game.grid}
          lastMove={session.lastMove}
          modeId={mode.id}
          movableColor="Blue"
          onPieceDrop={session.onPieceDrop}
          overlay={overlay}
          onTilePress={session.onTilePress}
          playerColor="Blue"
          selectedTile={session.selectedTile}
          validMoves={session.validMoves}
        />
      }
      button={
        <PrimaryButton
          accessibilityLabel={last ? 'Finish the lessons' : 'Next lesson'}
          disabled={!solved}
          label={last ? 'FINISH ▶' : 'NEXT ▶'}
          onPress={onNext}
        />
      }
      copy={
        <View style={[styles.copy, !layout.isWide && { width: layout.boardSize }]}>
          <Text style={styles.lessonTitle}>{lesson.title}</Text>
          {/* Read out when it changes, which is when it says something new. */}
          <View accessibilityLiveRegion="polite" style={styles.lineRow}>
            {solved || missed ? (
              <Text style={[styles.mark, missed && styles.markMissed]}>{solved ? '✓' : '✕'}</Text>
            ) : null}
            <Text style={styles.line}>{line}</Text>
          </View>
        </View>
      }
    />
  );
}

/**
 * The way out of the lessons and into a game: the real opening board, and the
 * bot it will be played against.
 */
function Finale({ mode, ...layout }: StepLayoutProps & { mode: ModeDefinition }) {
  const startBotGame = useGameStore((state) => state.startBotGame);
  // A game already on this device keeps the board; the same rule the Bots
  // page's buttons follow.
  const busy = useGameStore((state) => Boolean(state.gameState));
  const blocked = !isEngineAvailable() || busy;
  const opponent = botProfile(FIRST_OPPONENT_ID);
  const opening = useMemo(() => createAnalysisGame(mode), [mode]);

  return (
    <StepLayout
      {...layout}
      board={
        <Board
          boardSize={layout.boardSize}
          canMove={false}
          grid={opening.grid}
          lastMove={null}
          modeId={mode.id}
          onPieceDrop={noop}
          onTilePress={noop}
          playerColor="Blue"
          selectedTile={null}
          validMoves={[]}
        />
      }
      button={
        <PrimaryButton
          accessibilityLabel={`Play ${mode.name} against ${opponent.name}`}
          disabled={blocked}
          label={`PLAY ${opponent.name.toUpperCase()} ▶`}
          // Nothing navigates from here. A game in the store is what sends a
          // device to its board, from wherever it is — see `app/_layout`.
          onPress={() => startBotGame({ mode, profileId: opponent.id, playerColor: 'Blue' })}
        />
      }
      copy={
        <View style={[styles.copy, !layout.isWide && { width: layout.boardSize }]}>
          <Text style={styles.lessonTitle}>Ready for a real game</Text>
          <View style={styles.opponentRow}>
            <BotIcon profileId={opponent.id} size={44} />
            <Text style={[styles.line, styles.opponentLine]}>
              You move first. {opponent.name} is the gentlest bot here.
            </Text>
          </View>
        </View>
      }
    />
  );
}

const styles = themedSheet(() => ({
  safeArea: { flex: 1, backgroundColor: colors.background },
  screen: {
    flex: 1,
    width: '100%',
    maxWidth: 1100,
    alignSelf: 'center',
    paddingHorizontal: space.medium,
    paddingBottom: 10,
  },
  topBar: {
    minHeight: 64,
    flexDirection: 'row',
    alignItems: 'center',
    columnGap: 10,
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    marginBottom: space.medium,
  },
  titleCopy: { flex: 1, flexBasis: 120, minWidth: 0 },
  kicker: { color: colors.textFaint, fontSize: 8, fontWeight: '900', letterSpacing: 1.35 },
  title: { color: colors.textStrong, fontSize: 20, fontWeight: '900', marginTop: 2 },

  progress: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 4 },
  progressDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    borderWidth: 1,
    borderColor: colors.borderStrong,
  },
  progressDotDone: { backgroundColor: colors.textMuted, borderColor: colors.textMuted },
  progressDotCurrent: { borderColor: colors.textStrong, backgroundColor: colors.surfaceRaised },

  wideLayout: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'center',
    gap: space.xlarge,
  },
  widePanel: { width: SIDE_PANEL - space.xlarge, gap: space.large, paddingTop: space.small },
  phoneContent: { alignItems: 'center', gap: space.medium, paddingBottom: space.xlarge },
  phoneButton: { marginTop: space.tight },

  copy: { gap: space.snug },
  lessonTitle: { ...type.sectionTitle, color: colors.textStrong },
  // Room for three lines whatever the line says, so the board under it on a
  // phone stays where it is as the words change.
  lineRow: { flexDirection: 'row', alignItems: 'flex-start', gap: space.snug, minHeight: 57 },
  mark: { color: colors.textStrong, fontSize: 14, fontWeight: '900', lineHeight: 19 },
  markMissed: { color: colors.dangerText },
  line: { flex: 1, minWidth: 0, color: colors.textSoft, fontSize: 13, lineHeight: 19 },
  opponentRow: { flexDirection: 'row', alignItems: 'center', gap: space.medium, minHeight: 57 },
  opponentLine: { flex: 1 },

  reference: { gap: space.small },
  sectionLabel: { ...type.eyebrow, color: colors.textFaint },
  matchups: { flexDirection: 'row', gap: space.snug },
  matchup: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.snug,
    paddingVertical: space.small,
    borderRadius: radius.medium,
    backgroundColor: colors.surfaceSunken,
  },
  beats: { ...type.eyebrow, fontSize: 8, color: colors.textFaint },
  lessonRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.medium,
    paddingVertical: space.small,
    paddingHorizontal: space.medium,
    borderRadius: radius.medium,
  },
  lessonRowCurrent: { backgroundColor: colors.surfaceSunken },
  lessonNumber: { width: 14, color: colors.textFaint, fontSize: 12, fontWeight: '900', textAlign: 'center' },
  lessonName: { flex: 1, minWidth: 0, color: colors.textMuted, fontSize: 13, fontWeight: '700' },
  lessonTextCurrent: { color: colors.textStrong },
}));
