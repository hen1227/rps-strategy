import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type LayoutChangeEvent,
} from 'react-native';

import type { AnalysisGame } from '@/engine/analysisGame';
import { useSettledSearchParams } from '@/navigation/useSettledSearchParams';
import {
  lineKey,
  openingKind,
  openingNaming,
  seedOpeningCache,
  withPublishedName,
  withSuggestion,
  type OpeningBookBootstrap,
  type OpeningLine,
  type OpeningNodeView,
  type OpeningTitle,
} from '@/engine/openingBook';
import {
  gameAfterWalk,
  lastStepOfWalk,
  playBookMove,
  walkOpeningLine,
  type OpeningStep,
} from '@/engine/openingLine';
import type { OpeningStatsNode } from '@/engine/openingStats';
import { failureMessage } from '@/errors';
import EvalBar, { EVAL_BAR_WIDTH, formatScore } from '@/features/analysis/EvalBar';
import MiniBoard from '@/features/board/MiniBoard';
import { ApiError } from '@/store/api/http';
import {
  getOpeningBook,
  getOpeningNameSuggestions,
  getOpeningNames,
  getOpeningNode,
  getOpeningStats,
  nameOpeningLine,
  suggestOpeningName,
} from '@/store/api/openings';
import { useGameStore } from '@/store/gameStore';
import { colors, contentWidth, radius, space } from '@/theme';
import type { ModeDefinition, ModeID } from '@/types/game';
import ScreenShell from '@/ui/ScreenShell';
import TabBar from '@/ui/TabBar';
import { Badge, Banner, GhostButton, Panel } from '@/ui/primitives';

import CuratorPanel from './CuratorPanel';
import NameIndexPanel from './NameIndexPanel';
import MoveCard, { MOVE_CARD_GAP, moveCardWidthFor } from './MoveCard';
import NamePanel from './NamePanel';
import ExplorerLink from './ExplorerLink';
import { TurnDot, forcedLabel, redScore, sideOf, ui } from './openingsUi';
import { useOpeningCurator } from './useOpeningCurator';

/** Enough of a mode to label a tab, for before the server catalog arrives. */
interface ModeTab {
  id: ModeID;
  name: string;
  shortCode: string;
}

const FALLBACK_MODES: ModeTab[] = [
  { id: 'V6', name: 'Intransitive', shortCode: 'V6' },
  { id: 'V5', name: 'Total War', shortCode: 'V5' },
  { id: 'V3', name: 'Infiltration', shortCode: 'V3' },
];

// Board sizes, in points.
const MAIN_LINE_BOARD = 128;
const HERO_BOARD_MAX = 300;
const HERO_BOARD_MIN = 210;
/** What the hero board has to leave beside it: the eval bar, plus the row gap. */
const EVAL_BAR_COLUMN = EVAL_BAR_WIDTH + space.small;

/** Two columns fit here; below it the hero and the cards stack. */
const WIDE_ENOUGH = 720;

/**
 * What to call a line on its own card.
 *
 * An unnamed line with no named ancestor is titled "Suggest a name · d9-c8",
 * which is the right prompt on the hero and pure repetition on a card whose
 * heading is already `d9-c8`.
 */
const cardTitle = (title: OpeningTitle) =>
  title.exact || title.inherited ? title.label : 'Unnamed line';

interface FactProps {
  label: string;
  value: string;
}

function Fact({ label, value }: FactProps) {
  return (
    <View style={styles.fact}>
      <Text style={styles.factLabel}>{label}</Text>
      <Text style={styles.factValue}>{value}</Text>
    </View>
  );
}

/** What this book is, for the reader deciding whether to trust it. */
function BookFacts({ book }: { book: OpeningBookBootstrap }) {
  return (
    <View style={styles.facts}>
      <Fact label="POSITIONS" value={book.positionCount.toLocaleString()} />
      {book.maxPly ? <Fact label="PLIES DEEP" value={String(book.maxPly)} /> : null}
      <Fact label="ENGINE" value={`RPSFish ${book.engineVersion ?? '—'}`} />
      {book.updatedAtUnixMs ? (
        // Deliberately not a locale format: the pre-rendered build and the
        // browser would disagree, and React answers that by throwing the page
        // away. See `useSettled`.
        <Fact label="LAST SCAN" value={new Date(book.updatedAtUnixMs).toISOString().slice(0, 10)} />
      ) : null}
    </View>
  );
}

interface LineTrailProps {
  line: OpeningLine;
  onJump: (ply: number) => void;
}

/** The line so far, as steps you can walk back to. */
function LineTrail({ line, onJump }: LineTrailProps) {
  return (
    <View style={styles.trail}>
      <Pressable
        accessibilityLabel="Back to the opening position"
        accessibilityRole="button"
        onPress={() => onJump(0)}
        style={({ pressed }) => [styles.trailChip, pressed && ui.pressed]}
      >
        <Text style={styles.trailStart}>START</Text>
      </Pressable>
      {line.map((notation, index) => (
        <Pressable
          accessibilityLabel={`Back to ${notation}, move ${index + 1}`}
          accessibilityRole="button"
          key={`${index}-${notation}`}
          onPress={() => onJump(index + 1)}
          style={({ pressed }) => [
            styles.trailChip,
            index === line.length - 1 && styles.trailChipCurrent,
            pressed && ui.pressed,
          ]}
        >
          <Text style={styles.trailPly}>{index + 1}</Text>
          <Text
            style={[
              styles.trailNotation,
              index === line.length - 1 && styles.trailNotationCurrent,
            ]}
          >
            {notation}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}

interface MainLineStripProps {
  mainLine: OpeningLine;
  mode: ModeDefinition | null;
  modeId: ModeID;
  onOpen: (ply: number) => void;
}

/** The engine's best line, one board per move. */
function MainLineStrip({ mainLine, mode, modeId, onOpen }: MainLineStripProps) {
  const walk = useMemo(() => walkOpeningLine(mode, mainLine), [mode, mainLine.join(' ')]);
  if (!walk?.steps.length) return null;

  return (
    <ScrollView
      contentContainerStyle={styles.stripContent}
      horizontal
      showsHorizontalScrollIndicator={false}
      style={styles.strip}
    >
      {walk.steps.map((step, index) => (
        <Pressable
          accessibilityLabel={`Open the main line after ${step.notation}, move ${index + 1}`}
          accessibilityRole="button"
          key={`${index}-${step.notation}`}
          onPress={() => onOpen(index + 1)}
          style={({ pressed }) => [styles.stripCard, pressed && styles.stripCardPressed]}
        >
          <MiniBoard
            capture={step.captured}
            grid={step.game.grid}
            modeId={modeId}
            move={step.move}
            mover={step.mover}
            size={MAIN_LINE_BOARD}
          />
          <View style={styles.stripCaption}>
            <TurnDot turn={step.mover} />
            <Text style={styles.stripNumber}>{index + 1}</Text>
            <Text style={styles.stripNotation}>{step.notation}</Text>
          </View>
        </Pressable>
      ))}
    </ScrollView>
  );
}

export default function OpeningBookScreen() {
  const storeModes = useGameStore((state) => state.modes);
  const tabs: ModeTab[] = storeModes.length > 0 ? storeModes : FALLBACK_MODES;
  // `?mode=V3&line=d8-c7,f2-g3` opens the page on one line, which is how the
  // badge on a live board and the prompt at the end of a game reach the place
  // their opening is named. Seeded rather than forced, exactly as the
  // tournaments page treats its own link: walking somewhere else from here
  // still works, and the URL is not fought over.
  //
  // `settled` is why this is not read straight from `useLocalSearchParams`: a
  // pre-rendered page is built with no query string at all, so the parameters
  // arrive one render later than the page does.
  const { params, settled } = useSettledSearchParams<{ mode?: string; line?: string }>();
  const linkedMode = params.mode as ModeID | undefined;
  const linkedLine = params.line;
  const [modeId, setModeId] = useState<ModeID>(linkedMode ?? 'V6');
  const [bookData, setBookData] = useState<OpeningBookBootstrap | null>(null);
  const [line, setLine] = useState<OpeningLine>([]);
  // The book is a graph the server owns, so the screen keeps only what it has
  // actually looked at, keyed by the line that reached it. Seeded from the
  // bootstrap's featured openings, which is what makes those instant.
  const [nodes, setNodes] = useState<Map<string, OpeningNodeView>>(() => new Map());
  const [loading, setLoading] = useState(true);
  const [walking, setWalking] = useState(false);
  const [suggesting, setSuggesting] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [studioOpen, setStudioOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // One figure from the statistics, for the card that points at the explorer.
  // Fetched here rather than there because the card is on this page and the
  // number is what makes somebody click it; the explorer asks its own,
  // per-position questions when they arrive.
  const [stats, setStats] = useState<OpeningStatsNode | null>(null);
  // Boards are drawn at a size in points, so the grid has to be measured
  // rather than flexed. Zero until the first layout, which is also what the
  // build-time render reports — see `useSettled` for why that matters.
  const [pageWidth, setPageWidth] = useState(0);
  // And the hero panel separately. `pageWidth` is measured on the header, which
  // is outside this panel's padding, so it is 42pt more room than the board
  // actually has — the width of the padding and border either side. Sizing the
  // board from it overflowed the row by exactly that, invisibly: react-native-web
  // paints no scrollbar here.
  const [heroWidth, setHeroWidth] = useState(0);

  const tab = tabs.find((candidate) => candidate.id === modeId) ?? tabs[0];
  // The full definition, which is what carries the starting position every
  // diagram is replayed from. A mode the catalog has not delivered yet simply
  // has no boards; the rest of the page still works.
  const mode = storeModes.find((candidate) => candidate.id === modeId) ?? null;

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const bootstrap = await getOpeningBook(modeId);
      setBookData(bootstrap);
      setNodes(seedOpeningCache(bootstrap));
    } catch (requestError) {
      // A mode with no book yet is not a failure; it is the empty state.
      if (requestError instanceof ApiError && requestError.status === 404) {
        setBookData(null);
        setNodes(new Map());
      } else setError(failureMessage(requestError));
    } finally {
      setLoading(false);
    }
  }, [modeId]);

  // Held until the query string is readable, because until then this page does
  // not know which book it is: fetching first would download the default one
  // on the way to every link that names the other.
  useEffect(() => {
    if (settled) load();
  }, [load, settled]);

  // The link, applied as it arrives. Clearing the line belongs to the mode
  // tabs rather than to loading a book — see `chooseMode` — so a linked line
  // is not thrown away by the load its own mode sets off.
  useEffect(() => {
    if (linkedMode) setModeId(linkedMode);
  }, [linkedMode]);
  useEffect(() => {
    const linked = (linkedLine ?? '').split(',').filter(Boolean);
    if (linked.length > 0) setLine(linked);
  }, [linkedLine]);

  const book = bookData;
  const node = nodes.get(lineKey(line)) ?? null;

  // Names, open proposals and the mirror rule, indexed once per book rather
  // than re-scanned by every card on the page.
  const naming = useMemo(() => openingNaming(bookData ?? {}), [bookData]);

  const updateBook = useCallback(
    (change: (current: OpeningBookBootstrap) => OpeningBookBootstrap) =>
      setBookData((current) => (current ? change(current) : current)),
    [],
  );
  const curator = useOpeningCurator(modeId, updateBook, setNotice);

  // Fetch the position for a line the cache has not seen. A featured opening is
  // already there, so this is the cost of leaving the recommended paths.
  useEffect(() => {
    if (!bookData || node) return;
    let cancelled = false;
    setWalking(true);
    getOpeningNode(modeId, line)
      .then((response) => {
        if (cancelled) return;
        setNodes((current) => new Map(current).set(lineKey(response.line), response.node));
      })
      .catch((requestError) => {
        // Walking off the end of the book is the "scan stops here" state, not
        // an error worth a banner.
        if (!cancelled && !(requestError instanceof ApiError && requestError.status === 404)) {
          setError(failureMessage(requestError));
        }
      })
      .finally(() => {
        if (!cancelled) setWalking(false);
      });
    return () => {
      cancelled = true;
    };
  }, [bookData, modeId, node, lineKey(line)]);

  // The statistics, refetched when the mode or the cohort changes. Not part of
  // the bootstrap: the two are compiled by different things on different days,
  // and a book that failed to load should not take the counts with it.
  useEffect(() => {
    if (!settled) return;
    let cancelled = false;
    setStats(null);
    getOpeningStats(modeId)
      .then((result) => {
        if (!cancelled) setStats(result);
      })
      .catch((requestError) => {
        // A mode with no compile yet leaves the card on its generic wording.
        // Nothing on this page depends on the numbers, so a failure here is
        // not worth a banner over the book.
        if (!cancelled && !(requestError instanceof ApiError && requestError.status === 404)) {
          setError(failureMessage(requestError));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [modeId, settled]);

  // Every board on the page comes from replaying the line locally, so they are
  // all drawn before the server has said anything about the position.
  const walk = useMemo(() => walkOpeningLine(mode, line), [mode, lineKey(line)]);
  const game: AnalysisGame | null = gameAfterWalk(walk);
  const lastStep = lastStepOfWalk(walk);

  const title = naming.titleFor(line);
  const exactName = naming.nameFor(line);
  const mirrorLine = naming.mirrorOf(line);
  const turn = sideOf(node?.turn ?? game?.currentTurn, line.length);

  const isWide = pageWidth >= WIDE_ENOUGH;
  // What is left for the board once the eval bar beside it is paid for.
  const heroFit = Math.max(0, heroWidth - EVAL_BAR_COLUMN);
  const heroBoard = Math.round(
    Math.min(
      HERO_BOARD_MAX,
      Math.max(HERO_BOARD_MIN, isWide ? heroWidth * 0.38 : heroFit),
      // Last, so the floor gives way to it: a board held at HERO_BOARD_MIN on a
      // narrow phone pushes the eval bar out of the panel rather than shrinking.
      heroFit,
    ),
  );
  const cardWidth = moveCardWidthFor(pageWidth, !isWide);

  // One replay per candidate move, so each card can show where it lands.
  const moveBoards = useMemo(() => {
    const boards = new Map<string, OpeningStep | null>();
    for (const candidate of node?.moves ?? []) {
      boards.set(candidate.move, playBookMove(game, candidate.move));
    }
    return boards;
  }, [game, node]);

  const chooseMode = (nextModeId: ModeID) => {
    if (nextModeId === modeId) return;
    setModeId(nextModeId);
    // A line belongs to the book it was played in, so the other book opens at
    // its own beginning rather than at whatever this line's moves happen to
    // mean over there.
    setLine([]);
    setNotice(null);
  };

  /**
   * Name the line outright.
   *
   * The 409 case is somebody having named it first, and the honest answer is
   * to say what it is called rather than to report a failure: the person
   * typing wanted this line named, and it now is.
   */
  const submitName = async (name: string) => {
    setSuggesting(true);
    setError(null);
    try {
      const published = await nameOpeningLine(modeId, line, name);
      updateBook((current) => withPublishedName(current, published));
      setNotice(`This line is now called “${published.name}”.`);
      return true;
    } catch (requestError) {
      if (requestError instanceof ApiError && requestError.status === 409) {
        // Reload the naming layer so the winning name is on screen rather
        // than only in the message.
        try {
          const names = await getOpeningNames(modeId);
          updateBook((current) => ({ ...current, names: names.names ?? current.names }));
        } catch {
          // The message below still says what happened.
        }
        setNotice('Somebody named this line first — put your name forward as an alternative.');
        return false;
      }
      setError(failureMessage(requestError));
      return false;
    } finally {
      setSuggesting(false);
    }
  };

  const submitSuggestion = async (name: string) => {
    setSuggesting(true);
    setError(null);
    try {
      const suggestion = await suggestOpeningName(modeId, line, name);
      // Straight into the list under the form: a name you can see arrive is
      // the difference between "sent to the curators" and "sent nowhere".
      updateBook((current) => withSuggestion(current, suggestion));
      setNotice(`“${suggestion.name}” was added to this line's suggestions.`);
      return true;
    } catch (requestError) {
      setError(failureMessage(requestError));
      return false;
    } finally {
      setSuggesting(false);
    }
  };

  // The queue is the one part of the page somebody else can change while it is
  // open, so it is the one part with a refresh.
  const refreshSuggestions = async () => {
    setRefreshing(true);
    try {
      const suggestions = await getOpeningNameSuggestions(modeId);
      updateBook((current) => ({ ...current, suggestions }));
    } catch (requestError) {
      setError(failureMessage(requestError));
    } finally {
      setRefreshing(false);
    }
  };

  const measure = (event: LayoutChangeEvent) => setPageWidth(event.nativeEvent.layout.width);
  const measureHero = (event: LayoutChangeEvent) => setHeroWidth(event.nativeEvent.layout.width);
  const forced = node ? forcedLabel(node.score) : null;

  const heroDiagram = game && heroWidth > 0 && (
    <View style={styles.heroBoardRow}>
      <MiniBoard
        capture={lastStep?.captured}
        grid={game.grid}
        modeId={modeId}
        move={lastStep?.move}
        mover={lastStep?.mover}
        size={heroBoard}
      />
      <EvalBar height={heroBoard} redScore={node ? redScore(node.score, turn) : null} />
    </View>
  );

  return (
    <ScreenShell width={contentWidth.page}>
      <>
        {/* No back button: the shell's navigation is already the way out. */}
        <View onLayout={measure} style={styles.header}>
          <View style={styles.headerCopy}>
            <Text style={styles.brand}>RPS OPENINGS</Text>
            <Text style={styles.headerSubtitle}>
              A living book, analyzed by RPSFish and named by players.
            </Text>
          </View>
          {/* An administrator arrives already unlocked, so the switch — not a
              token form — is the whole of the door they see. */}
          {curator.available && (
            <Pressable
              accessibilityRole="switch"
              accessibilityState={{ checked: curator.active }}
              onPress={() => curator.setActive(!curator.active)}
              style={({ pressed }) => [
                styles.curatorSwitch,
                curator.active && styles.curatorSwitchOn,
                pressed && ui.pressed,
              ]}
            >
              <Text
                style={[styles.curatorSwitchText, curator.active && styles.curatorSwitchTextOn]}
              >
                {curator.active ? 'CURATING' : 'CURATOR MODE'}
              </Text>
            </Pressable>
          )}
        </View>

        <TabBar
          accessibilityLabel="Game mode"
          // `fill`: the hand-rolled row these replaced stretched its tabs to
          // share the width, and at three modes that is what reads as one
          // control rather than three buttons.
          fill
          onChange={chooseMode}
          options={tabs.map((candidate) => ({
            value: candidate.id,
            label: candidate.name,
            eyebrow: candidate.shortCode ?? candidate.id,
          }))}
          value={modeId}
        />

        <Banner message={error} onDismiss={() => setError(null)} tone="error" />
        <Banner message={curator.error} onDismiss={curator.dismissError} tone="error" />
        <Banner message={notice} onDismiss={() => setNotice(null)} />

        {loading ? (
          <View style={styles.loadingState}>
            <ActivityIndicator color={colors.accentBright} />
            <Text style={styles.loadingText}>Opening the {tab?.name ?? modeId} book…</Text>
          </View>
        ) : !book ? (
          <Panel style={styles.emptyBook} tone="accent">
            <View style={styles.emptyRow}>
              {game && pageWidth > 0 && (
                <MiniBoard grid={game.grid} modeId={modeId} size={Math.min(180, pageWidth)} />
              )}
              <View style={styles.emptyCopyColumn}>
                <Text style={ui.eyebrow}>BOOK IN PREPARATION</Text>
                <Text style={styles.emptyTitle}>
                  No {tab?.name ?? modeId} scan has been imported yet.
                </Text>
                <Text style={styles.emptyCopy}>
                  This is the position it will start from. Run RPSFish’s book builder and publish
                  it from the shell — `scripts/build_books.sh --publish` — and this page fills in.
                </Text>
              </View>
            </View>
          </Panel>
        ) : (
          <>
            <Panel style={styles.hero} tone="accent">
              <View
                onLayout={measureHero}
                style={[styles.heroLayout, isWide && styles.heroLayoutWide]}
              >
                {heroDiagram}
                <View style={styles.heroCopy}>
                  <View style={styles.heroEyebrowRow}>
                    <Text style={ui.eyebrow}>{openingKind(line).toUpperCase()}</Text>
                    <View style={styles.turnTag}>
                      <TurnDot turn={turn} />
                      <Text style={styles.turnTagText}>{turn.toUpperCase()} TO MOVE</Text>
                    </View>
                  </View>
                  <Text style={styles.heroTitle}>{title.label}</Text>
                  {title.inherited && (
                    <Text style={styles.inheritanceCopy}>
                      Inherited from {title.namedAncestor?.name}; this last move can still earn its
                      own variation name.
                    </Text>
                  )}
                  <View style={styles.heroMeta}>
                    {exactName ? (
                      <Badge label="PUBLISHED NAME" tone="gold" />
                    ) : (
                      <Badge label="NAME WANTED" />
                    )}
                    {naming.suggestionsFor(line).length > 0 && !exactName && (
                      <Badge
                        label={`${naming.suggestionsFor(line).length} SUGGESTED`}
                        tone="accent"
                      />
                    )}
                    {forced && <Badge label={forced} tone="warm" />}
                    {node && <Badge label={`DEPTH ${node.depth}`} tone="accent" />}
                    {node && <Badge label={`${node.nodes.toLocaleString()} NODES`} />}
                  </View>
                  {/* The book holds both halves of every mirror pair, because
                      both are boards you can reach. Naming is folded onto one
                      of them, and saying so is what stops the other looking
                      like an opening somebody forgot. */}
                  {mirrorLine && (
                    <View style={styles.mirrorRow}>
                      <Text style={styles.mirrorText}>
                        Mirror image of {mirrorLine.join('  ')} — one opening, two ways round, one
                        name.
                      </Text>
                      <GhostButton
                        compact
                        label="VIEW MIRROR"
                        onPress={() => setLine(mirrorLine)}
                      />
                    </View>
                  )}
                  {line.length > 0 && (
                    <>
                      <LineTrail
                        line={line}
                        onJump={(ply) => setLine((current) => current.slice(0, ply))}
                      />
                      <View style={styles.heroActions}>
                        <GhostButton
                          compact
                          label="← BACK"
                          onPress={() => setLine((current) => current.slice(0, -1))}
                        />
                      </View>
                    </>
                  )}
                  <BookFacts book={book} />
                </View>
              </View>
            </Panel>

            {/* The main line stays, one rung down: it is the engine's best
                continuation regardless of how sure it is, which is still worth
                seeing next to the lines it will vouch for. */}
            {line.length === 0 && book.mainLine.length > 0 && (
              <Panel style={styles.mainLinePanel}>
                <View style={styles.sectionHeader}>
                  <View style={styles.sectionHeaderCopy}>
                    <Text style={ui.eyebrow}>DEEPEST LINE</Text>
                    <Text style={styles.sectionTitle}>Main line</Text>
                  </View>
                  <Badge label={`${book.mainLine.length} PLIES`} tone="accent" />
                </View>
                <Text style={styles.sectionCopy}>
                  RPSFish’s best continuation through the analyzed graph, board by board — followed
                  as far as the scan goes rather than as far as it is certain. Tap any move to open
                  that position.
                </Text>
                <MainLineStrip
                  mainLine={book.mainLine}
                  mode={mode}
                  modeId={modeId}
                  onOpen={(ply) => setLine(book.mainLine.slice(0, ply))}
                />
              </Panel>
            )}

            <View style={styles.moveSection}>
              <View style={styles.sectionHeader}>
                <View style={styles.sectionHeaderCopy}>
                  <Text style={ui.eyebrow}>
                    {line.length === 0 ? 'FIRST MOVES' : 'BEST RESPONSES'}
                  </Text>
                  <Text style={styles.sectionTitle}>
                    {walking && !node
                      ? 'Reading the book…'
                      : node?.moves?.length
                        ? `${turn}’s book choices`
                        : 'End of the imported line'}
                  </Text>
                </View>
                {node && (
                  <Badge
                    label={forced ?? formatScore(node.score)}
                    tone={node.score >= 0 ? 'accent' : 'warm'}
                  />
                )}
              </View>
              {/* A position the cache has not seen yet is a fetch in flight,
                  not the end of the book. Saying "the scan stops here" while
                  the answer is still on the wire would be a lie that clears
                  itself a moment later. */}
              {walking && !node ? (
                <Panel style={styles.frontierPanel}>
                  <ActivityIndicator color={colors.accent} />
                </Panel>
              ) : !node?.moves?.length ? (
                <Panel style={styles.frontierPanel}>
                  <Text style={styles.frontierTitle}>The scan stops here for now.</Text>
                  <Text style={styles.frontierCopy}>
                    This line can still be named. A later engine import can add responses without
                    losing that name.
                  </Text>
                </Panel>
              ) : (
                <View style={styles.moveGrid}>
                  {cardWidth > 0 &&
                    node.moves.map((candidate) => {
                      const childLine = [...line, candidate.move];
                      const childName = naming.titleFor(childLine);
                      return (
                        <MoveCard
                          after={moveBoards.get(candidate.move) ?? null}
                          childName={cardTitle(childName)}
                          isMainLine={Boolean(candidate.mainLine)}
                          key={candidate.move}
                          modeId={modeId}
                          move={candidate.move}
                          nameWanted={childName.suggestionNeeded}
                          onOpen={() => setLine(childLine)}
                          rank={candidate.rank}
                          score={candidate.score}
                          status={
                            candidate.repetition
                              ? 'Repetition · branch rejoins this line'
                              : candidate.child
                                ? `${candidate.childTurn} response · searched to depth ${candidate.childDepth}`
                                : candidate.searched
                                  ? 'Analyzed transposition · continue from its named line'
                                  : 'Frontier · waiting for a deeper scan'
                          }
                          suggested={naming.suggestionsFor(childLine).length}
                          turn={turn}
                          width={cardWidth}
                        />
                      );
                    })}
                </View>
              )}
            </View>

            <NamePanel
              curator={curator}
              line={line}
              naming={naming}
              onName={submitName}
              onOpenLine={setLine}
              onSuggest={submitSuggestion}
              suggesting={suggesting}
            />

            {/* What people *play* is a different claim from what the engine
                recommends, and it wants a board you can move pieces on rather
                than a section at the foot of a six-screen page. It has its own
                one; this is the door. */}
            <ExplorerLink line={line} modeId={modeId} stats={stats} />

            <NameIndexPanel modeId={modeId} onOpenLine={setLine} />
          </>
        )}

        {curator.active || studioOpen ? (
          <CuratorPanel
            curator={curator}
            line={line}
            mode={mode}
            modeId={modeId}
            moveBoards={moveBoards}
            moves={node?.moves ?? []}
            naming={naming}
            onOpenLine={setLine}
            onRefresh={refreshSuggestions}
            refreshing={refreshing}
          />
        ) : (
          // Somebody who is already unlocked has simply switched the controls
          // off, so the way back in is the switch, not a second panel telling
          // them about it.
          <Pressable
            accessibilityRole="button"
            onPress={() => (curator.available ? curator.setActive(true) : setStudioOpen(true))}
            style={({ pressed }) => [styles.curateLink, pressed && ui.pressed]}
          >
            <Text style={styles.curateLinkText}>CURATE THIS BOOK</Text>
          </Pressable>
        )}
      </>
    </ScreenShell>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  headerCopy: { flexGrow: 1, flexShrink: 1, minWidth: 0 },
  brand: { color: colors.accentBright, fontSize: 15, fontWeight: '900', letterSpacing: 1.2 },
  headerSubtitle: { color: colors.textMuted, fontSize: 11, marginTop: 2 },
  curatorSwitch: {
    paddingHorizontal: 11,
    paddingVertical: 7,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.medium,
    backgroundColor: colors.surface,
  },
  curatorSwitchOn: { borderColor: colors.goldBorder, backgroundColor: colors.goldSurfaceDeep },
  curatorSwitchText: { color: colors.textFaint, fontSize: 8, fontWeight: '900', letterSpacing: 1 },
  curatorSwitchTextOn: { color: colors.goldBright },

  loadingState: { alignItems: 'center', justifyContent: 'center', gap: 10, paddingVertical: 70 },
  loadingText: { color: colors.textMuted, fontSize: 12 },
  emptyBook: { paddingVertical: 26 },
  emptyRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: space.large },
  emptyCopyColumn: { flexGrow: 1, flexShrink: 1, flexBasis: 240, minWidth: 0 },
  emptyTitle: { color: colors.textStrong, fontSize: 22, fontWeight: '900', marginTop: 7 },
  emptyCopy: { color: colors.textMuted, fontSize: 12, lineHeight: 19, marginTop: 8, maxWidth: 680 },

  hero: { padding: 20 },
  heroLayout: { gap: space.large },
  heroLayoutWide: { flexDirection: 'row', alignItems: 'flex-start' },
  heroBoardRow: { flexDirection: 'row', alignItems: 'flex-start', gap: space.small },
  heroCopy: { flex: 1, minWidth: 0 },
  heroEyebrowRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 10 },
  turnTag: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  turnTagText: { color: colors.textSubtle, fontSize: 8, fontWeight: '900', letterSpacing: 1.2 },
  heroTitle: {
    color: colors.textStrong,
    fontSize: 26,
    lineHeight: 32,
    fontWeight: '900',
    marginTop: 6,
  },
  heroMeta: { flexDirection: 'row', flexWrap: 'wrap', gap: 7, marginTop: 12 },
  heroActions: { flexDirection: 'row', gap: 8, marginTop: 12 },
  inheritanceCopy: { color: colors.textMuted, fontSize: 11, lineHeight: 17, marginTop: 8 },
  mirrorRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: space.small,
    marginTop: 12,
  },
  mirrorText: {
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: 200,
    minWidth: 0,
    color: colors.textSubtle,
    fontSize: 11,
    lineHeight: 17,
  },

  facts: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: space.large,
    marginTop: 16,
    paddingTop: 14,
    borderTopWidth: 1,
    borderTopColor: colors.accentBorder,
  },
  fact: { minWidth: 74 },
  factLabel: { color: colors.textFaint, fontSize: 7, fontWeight: '900', letterSpacing: 1 },
  factValue: { color: colors.textSoft, fontSize: 13, fontWeight: '800', marginTop: 3 },

  trail: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 5, marginTop: 14 },
  trailChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 7,
    paddingVertical: 5,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.small,
    backgroundColor: colors.surfaceSunken,
  },
  trailChipCurrent: { borderColor: colors.accentBorder, backgroundColor: colors.accentSurface },
  trailStart: { color: colors.textFaint, fontSize: 8, fontWeight: '900', letterSpacing: 1 },
  trailPly: { color: colors.textFaint, fontSize: 8, fontWeight: '900' },
  trailNotation: { color: colors.textSubtle, fontSize: 11, fontWeight: '800' },
  trailNotationCurrent: { color: colors.textStrong },

  mainLinePanel: { padding: 18 },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 10,
  },
  sectionHeaderCopy: { flex: 1, minWidth: 0 },
  sectionTitle: { color: colors.textStrong, fontSize: 20, fontWeight: '900', marginTop: 3 },
  sectionCopy: { color: colors.textMuted, fontSize: 11, lineHeight: 17, marginTop: 7 },

  strip: { marginTop: 14, marginHorizontal: -4 },
  stripContent: { gap: 8, paddingHorizontal: 4, paddingBottom: 2 },
  stripCard: {
    padding: 6,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.medium,
    backgroundColor: colors.surfaceSunken,
  },
  stripCardPressed: { borderColor: colors.accentBorder, backgroundColor: colors.accentSurfaceQuiet },
  stripCaption: { flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 6 },
  stripNumber: { color: colors.textFaint, fontSize: 9, fontWeight: '900' },
  stripNotation: { color: colors.textStrong, fontSize: 11, fontWeight: '900' },

  moveSection: { gap: 10 },
  moveGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: MOVE_CARD_GAP },
  frontierPanel: { paddingVertical: 22 },
  frontierTitle: { color: colors.textStrong, fontSize: 14, fontWeight: '900' },
  frontierCopy: { color: colors.textMuted, fontSize: 11, lineHeight: 17, marginTop: 5 },

  curateLink: { alignSelf: 'center', paddingHorizontal: 12, paddingVertical: 9, marginTop: 10 },
  curateLinkText: { color: colors.textFaint, fontSize: 8, fontWeight: '900', letterSpacing: 1 },
});
