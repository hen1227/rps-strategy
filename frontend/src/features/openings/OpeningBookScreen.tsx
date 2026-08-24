import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type LayoutChangeEvent,
} from 'react-native';

import type { AnalysisGame } from '@/engine/analysisGame';
import { winPercent } from '@/engine/gameReview';
import {
  exactOpeningName,
  lineKey,
  openingKind,
  openingNameForLine,
  seedOpeningCache,
  validateOpeningBookDocument,
  type OpeningBookBootstrap,
  type OpeningLine,
  type OpeningName,
  type OpeningNameSuggestion,
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
import { failureMessage } from '@/errors';
import EvalBar, { formatScore } from '@/features/analysis/EvalBar';
import MiniBoard from '@/features/board/MiniBoard';
import { useAdminToken } from '@/hooks/useAdminToken';
import { ApiError } from '@/store/api/http';
import {
  approveOpeningNameSuggestion,
  getOpeningBook,
  getOpeningNameSuggestions,
  getOpeningNode,
  importOpeningBook,
  setOpeningName,
  suggestOpeningName,
} from '@/store/api/openings';
import { useGameStore } from '@/store/gameStore';
import { colors, contentWidth, players, radius, space } from '@/theme';
import { opposingColor, type ModeDefinition, type ModeID, type SideColor } from '@/types/game';
import ScreenShell from '@/ui/ScreenShell';
import { Badge, Banner, GhostButton, Panel, PrimaryButton } from '@/ui/primitives';

/** Enough of a mode to label a tab, for before the server catalog arrives. */
interface ModeTab {
  id: ModeID;
  name: string;
  shortCode: string;
}

const FALLBACK_MODES: ModeTab[] = [
  { id: 'V3', name: 'Infiltration', shortCode: 'V3' },
  { id: 'V5', name: 'Total War', shortCode: 'V5' },
];

// Board sizes, in points. The move grid picks its own from the room it has;
// these are the bounds it picks between.
const MOVE_CARD_MIN = 186;
const MOVE_CARD_MIN_NARROW = 150;
const MOVE_CARD_MAX = 250;
const CARD_GAP = 10;
const CARD_PADDING = 9;
const MAIN_LINE_BOARD = 128;
const SUGGESTION_BOARD = 70;
const HERO_BOARD_MAX = 300;
const HERO_BOARD_MIN = 210;
const EVAL_BAR_COLUMN = 39;

/** Two columns fit here; below it the hero and the cards stack. */
const WIDE_ENOUGH = 720;

/**
 * A score past this is a forced result rather than an assessment.
 *
 * RPSFish's own threshold (`search.rs`), which is what the book's scores are
 * written on: past it the number counts plies to the end, not centipawns.
 */
const FORCED_RESULT = 29_000;

const sideOf = (turn: string | undefined, ply: number): SideColor =>
  turn === 'Blue' || turn === 'Red' ? turn : ply % 2 === 0 ? 'Red' : 'Blue';

/**
 * The book scores every position for whoever is to move, so a bar that always
 * fills from Red's side has to turn Blue's numbers around first.
 */
const redScore = (score: number, turn: SideColor) => (turn === 'Blue' ? -score : score);

const forcedLabel = (score: number) =>
  score >= FORCED_RESULT ? 'FORCED WIN' : score <= -FORCED_RESULT ? 'FORCED LOSS' : null;

/**
 * What to call a line on its own card.
 *
 * An unnamed line with no named ancestor is titled "Suggest a name · d9-c8",
 * which is the right prompt on the hero and pure repetition on a card whose
 * heading is already `d9-c8`.
 */
const cardTitle = (title: OpeningTitle) =>
  title.exact || title.inherited ? title.label : 'Unnamed line';

const mergeName = (
  names: OpeningName[] | null | undefined,
  published: OpeningName,
): OpeningName[] => [
  ...(names ?? []).filter(
    (candidate) => candidate.line.join(' ') !== published.line.join(' '),
  ),
  published,
];

/**
 * How wide one move card should be, given the room the grid has.
 *
 * Cards are square-ish boards with a caption, so they tile: fit as many whole
 * columns as will hold a legible board, then share the row out between them so
 * the grid has no ragged right edge.
 */
const cardWidthFor = (available: number) => {
  if (available <= 0) return 0;
  // A phone has room for one card at the desktop minimum, which would make a
  // book of twenty-three first moves nine thousand pixels long. Two smaller
  // boards halve that and stay legible; the arrow is the thing that has to
  // survive, and it does.
  const smallest = available < WIDE_ENOUGH ? MOVE_CARD_MIN_NARROW : MOVE_CARD_MIN;
  const columns = Math.max(1, Math.floor((available + CARD_GAP) / (smallest + CARD_GAP)));
  const width = (available - CARD_GAP * (columns - 1)) / columns;
  return Math.floor(Math.min(width, columns === 1 ? available : MOVE_CARD_MAX));
};

interface TurnDotProps {
  turn: SideColor;
}

function TurnDot({ turn }: TurnDotProps) {
  return <View style={[styles.turnDot, { backgroundColor: players[turn].strong }]} />;
}

/**
 * How much of the point the side to move expects, drawn as one bar.
 *
 * Measured from the middle rather than from zero. Openings are close by
 * definition — twenty candidate moves here span three percent of expected
 * score — and a bar that filled from the left would be twenty identical
 * half-full bars. From the centre, the same three percent is the difference
 * between leaning one way and leaning the other, which is the thing worth
 * seeing.
 */
interface ExpectationBarProps {
  modeId: ModeID;
  score: number;
  turn: SideColor;
}

function ExpectationBar({ modeId, score, turn }: ExpectationBarProps) {
  const share = Math.max(1, Math.min(99, winPercent(score, modeId)));
  const ahead = share >= 50;
  const owner = ahead ? turn : opposingColor(turn);
  return (
    <View
      accessibilityLabel={`${owner} expects ${Math.round(Math.max(share, 100 - share))}% of the point`}
      style={styles.expectation}
    >
      <View
        style={[
          styles.expectationFill,
          {
            backgroundColor: players[owner].strong,
            left: `${ahead ? 50 : share}%`,
            width: `${Math.max(1.2, Math.abs(share - 50))}%`,
          },
        ]}
      />
      <View style={styles.expectationCentre} />
    </View>
  );
}

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
        style={({ pressed }) => [styles.trailChip, pressed && styles.pressed]}
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
            pressed && styles.pressed,
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

interface MoveCardProps {
  /** The board this move produces, when the rules could replay it. */
  after: OpeningStep | null;
  childName: string;
  modeId: ModeID;
  nameWanted: boolean;
  onOpen: () => void;
  score: number;
  status: string;
  isMainLine: boolean;
  move: string;
  rank: number;
  turn: SideColor;
  width: number;
}

function MoveCard({
  after,
  childName,
  modeId,
  nameWanted,
  onOpen,
  score,
  status,
  isMainLine,
  move,
  rank,
  turn,
  width,
}: MoveCardProps) {
  const boardSize = width - CARD_PADDING * 2;
  const forced = forcedLabel(score);

  return (
    <Pressable
      accessibilityLabel={`Explore ${move}, ${childName}`}
      accessibilityRole="button"
      onPress={onOpen}
      style={({ pressed }) => [
        styles.moveCard,
        { width },
        isMainLine && styles.moveCardMain,
        pressed && styles.moveCardPressed,
      ]}
    >
      <View style={[styles.moveBoard, { height: boardSize, width: boardSize }]}>
        {after ? (
          <MiniBoard
            capture={after.captured}
            grid={after.game.grid}
            modeId={modeId}
            move={after.move}
            mover={after.mover}
            size={boardSize}
          />
        ) : (
          <View style={styles.moveBoardMissing}>
            <Text style={styles.moveBoardMissingText}>{move}</Text>
          </View>
        )}
        <View style={styles.rankChip}>
          <Text style={styles.rankNumber}>{rank}</Text>
        </View>
        {isMainLine && (
          <View style={styles.mainFlag}>
            <Text style={styles.mainFlagText}>MAIN</Text>
          </View>
        )}
      </View>

      <ExpectationBar modeId={modeId} score={score} turn={turn} />

      <View style={styles.moveHeadline}>
        <TurnDot turn={turn} />
        <Text style={styles.moveNotation}>{move}</Text>
        <Text style={[styles.moveScore, forced && styles.moveScoreForced]}>
          {forced ?? formatScore(score)}
        </Text>
      </View>
      <Text numberOfLines={2} style={[styles.moveName, nameWanted && styles.moveNameWanted]}>
        {childName}
      </Text>
      <Text numberOfLines={2} style={styles.moveStatus}>
        {status}
      </Text>
    </Pressable>
  );
}

interface NameFormProps {
  busy?: boolean;
  /** The nearest named ancestor, when this line inherits its label. */
  inheritedFrom: OpeningName | null;
  line: OpeningLine;
  /** Resolves false when the suggestion was not accepted, so the draft stays. */
  onSubmit: (name: string) => Promise<boolean>;
  publishedName: OpeningName | null;
}

function NameForm({ busy, inheritedFrom, line, onSubmit, publishedName }: NameFormProps) {
  const [draft, setDraft] = useState('');

  useEffect(() => {
    setDraft('');
  }, [line.join(' ')]);

  if (!line.length || publishedName) return null;
  return (
    <Panel style={styles.namePanel} tone="accent">
      <Text style={styles.eyebrow}>COMMUNITY NAME</Text>
      <Text style={styles.namePrompt}>This line needs a name.</Text>
      <Text style={styles.nameHelp}>
        {inheritedFrom
          ? `It currently lives under ${inheritedFrom.name}. Suggest a defense, gambit, variation—or something stranger.`
          : 'Chess has openings, defenses, gambits, and systems. We can borrow the structure without borrowing the seriousness.'}
      </Text>
      <View style={styles.formRow}>
        <TextInput
          accessibilityLabel="Suggested opening name"
          maxLength={80}
          onChangeText={setDraft}
          onSubmitEditing={() =>
            draft.trim() && onSubmit(draft.trim()).then((sent) => sent && setDraft(''))
          }
          placeholder="e.g. The Skipping Stone"
          placeholderTextColor={colors.textFaint}
          returnKeyType="send"
          selectionColor={colors.accentBright}
          style={styles.textInput}
          value={draft}
        />
        <PrimaryButton
          compact
          disabled={!draft.trim()}
          label="SUGGEST"
          loading={busy}
          onPress={() => onSubmit(draft.trim()).then((sent) => sent && setDraft(''))}
        />
      </View>
    </Panel>
  );
}

interface AdminStudioProps {
  names: OpeningName[];
  line: OpeningLine;
  mode: ModeDefinition | null;
  modeId: ModeID;
  onBookImported: () => void;
  onNamePublished: (name: OpeningName) => void;
  onNotice: (message: string) => void;
}

function AdminStudio({
  names,
  line,
  mode,
  modeId,
  onBookImported,
  onNamePublished,
  onNotice,
}: AdminStudioProps) {
  const [open, setOpen] = useState(false);
  const admin = useAdminToken();
  const adminToken = admin.token;
  const [tokenDraft, setTokenDraft] = useState('');
  const [jsonDraft, setJsonDraft] = useState('');
  const [nameDraft, setNameDraft] = useState('');
  const [suggestions, setSuggestions] = useState<OpeningNameSuggestion[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const published = exactOpeningName(names, line);

  useEffect(() => {
    setNameDraft(published?.name ?? '');
  }, [published?.name, line.join(' ')]);

  const loadSuggestions = useCallback(
    async (token = adminToken) => {
      if (!token) return;
      const pending = await getOpeningNameSuggestions(token, modeId);
      setSuggestions(pending);
    },
    [adminToken, modeId],
  );

  const unlock = async (candidate: string) => {
    if (!candidate.trim()) return;
    setBusy('unlock');
    setError(null);
    if (await admin.unlock(candidate)) {
      setTokenDraft('');
      await loadSuggestions(candidate.trim());
    } else {
      setError(admin.error ?? 'That token was not accepted.');
    }
    setBusy(null);
  };

  // Re-verifying a saved token is the hook's job now; opening the panel is
  // what tells it to.
  const toggle = () => setOpen(!open);

  const importJSON = async () => {
    setBusy('import');
    setError(null);
    try {
      const parsed = validateOpeningBookDocument(JSON.parse(jsonDraft), modeId);
      const imported = await importOpeningBook(adminToken, modeId, parsed);
      setJsonDraft('');
      onBookImported();
      onNotice(`Imported ${imported.positionCount.toLocaleString()} analyzed positions.`);
    } catch (requestError) {
      setError(
        requestError instanceof SyntaxError
          ? 'That is not valid JSON.'
          : failureMessage(requestError),
      );
    } finally {
      setBusy(null);
    }
  };

  const publishName = async () => {
    setBusy('name');
    setError(null);
    try {
      const named = await setOpeningName(adminToken, modeId, line, nameDraft.trim());
      onNamePublished(named);
      onNotice(`Published “${named.name}”.`);
    } catch (requestError) {
      setError(failureMessage(requestError));
    } finally {
      setBusy(null);
    }
  };

  const approve = async (suggestion: OpeningNameSuggestion) => {
    setBusy(`approve-${suggestion.suggestionId}`);
    setError(null);
    try {
      const named = await approveOpeningNameSuggestion(
        adminToken,
        modeId,
        suggestion.suggestionId,
      );
      onNamePublished(named);
      await loadSuggestions(adminToken);
      onNotice(`Published “${named.name}”.`);
    } catch (requestError) {
      setError(failureMessage(requestError));
    } finally {
      setBusy(null);
    }
  };

  return (
    <View style={styles.adminWrap}>
      <Pressable
        accessibilityRole="button"
        onPress={toggle}
        style={({ pressed }) => [styles.curateLink, pressed && styles.pressed]}
      >
        <Text style={styles.curateLinkText}>{open ? 'CLOSE CURATOR STUDIO' : 'CURATE THIS BOOK'}</Text>
      </Pressable>
      {open && (
        <Panel style={styles.adminPanel}>
          <Text style={styles.eyebrow}>CURATOR STUDIO</Text>
          <Text style={styles.adminTitle}>Import scans and publish names</Text>
          <Text style={styles.adminHelp}>
            RPSFish exports this exact JSON. A new scan replaces engine analysis while every human name stays put.
          </Text>
          <Banner message={error} onDismiss={() => setError(null)} tone="error" />
          {!adminToken ? (
            <View style={styles.formRow}>
              <TextInput
                accessibilityLabel="Opening curator admin token"
                onChangeText={setTokenDraft}
                onSubmitEditing={() => unlock(tokenDraft)}
                placeholder="Admin token"
                placeholderTextColor={colors.textFaint}
                secureTextEntry
                selectionColor={colors.accentBright}
                style={styles.textInput}
                value={tokenDraft}
              />
              <PrimaryButton
                compact
                disabled={!tokenDraft.trim()}
                label="UNLOCK"
                loading={busy === 'unlock'}
                onPress={() => unlock(tokenDraft)}
              />
            </View>
          ) : (
            <View style={styles.adminSections}>
              <View>
                <Text style={styles.fieldLabel}>RPSFISH EXPORT JSON</Text>
                <TextInput
                  accessibilityLabel="RPSFish opening book JSON"
                  multiline
                  onChangeText={setJsonDraft}
                  placeholder='Paste the result of “book export”…'
                  placeholderTextColor={colors.textFaint}
                  selectionColor={colors.accentBright}
                  style={[styles.textInput, styles.jsonInput]}
                  textAlignVertical="top"
                  value={jsonDraft}
                />
                <PrimaryButton
                  disabled={!jsonDraft.trim()}
                  label="IMPORT BOOK"
                  loading={busy === 'import'}
                  onPress={importJSON}
                />
              </View>

              {line.length > 0 && (
                <View>
                  <Text style={styles.fieldLabel}>PUBLISHED NAME FOR {line.join('  ')}</Text>
                  <View style={styles.formRow}>
                    <TextInput
                      accessibilityLabel="Published opening name"
                      maxLength={80}
                      onChangeText={setNameDraft}
                      placeholder="Name this line"
                      placeholderTextColor={colors.textFaint}
                      selectionColor={colors.accentBright}
                      style={styles.textInput}
                      value={nameDraft}
                    />
                    <PrimaryButton
                      compact
                      disabled={!nameDraft.trim()}
                      label="PUBLISH"
                      loading={busy === 'name'}
                      onPress={publishName}
                    />
                  </View>
                </View>
              )}

              <View>
                <View style={styles.suggestionHeading}>
                  <Text style={styles.fieldLabel}>PENDING SUGGESTIONS</Text>
                  <GhostButton compact label="REFRESH" onPress={() => loadSuggestions()} />
                </View>
                {suggestions.length === 0 ? (
                  <Text style={styles.adminHelp}>No names are waiting for review.</Text>
                ) : (
                  <View style={styles.suggestionList}>
                    {suggestions.map((suggestion) => (
                      <SuggestionRow
                        busy={busy === `approve-${suggestion.suggestionId}`}
                        key={suggestion.suggestionId}
                        mode={mode}
                        modeId={modeId}
                        onApprove={() => approve(suggestion)}
                        suggestion={suggestion}
                      />
                    ))}
                  </View>
                )}
              </View>
            </View>
          )}
        </Panel>
      )}
    </View>
  );
}

interface SuggestionRowProps {
  busy: boolean;
  mode: ModeDefinition | null;
  modeId: ModeID;
  onApprove: () => void;
  suggestion: OpeningNameSuggestion;
}

/** One pending name, beside the position somebody is proposing to name. */
function SuggestionRow({ busy, mode, modeId, onApprove, suggestion }: SuggestionRowProps) {
  const line = suggestion.line ?? [];
  const walk = useMemo(() => walkOpeningLine(mode, line), [mode, line.join(' ')]);
  const step = lastStepOfWalk(walk);
  const game = gameAfterWalk(walk);

  return (
    <View style={styles.suggestionRow}>
      {game && (
        <MiniBoard
          capture={step?.captured}
          grid={game.grid}
          modeId={modeId}
          move={step?.move}
          mover={step?.mover}
          size={SUGGESTION_BOARD}
        />
      )}
      <View style={styles.suggestionCopy}>
        <Text style={styles.suggestionName}>{suggestion.name}</Text>
        <Text style={styles.suggestionLine}>{line.join('  ')}</Text>
      </View>
      <PrimaryButton compact label="APPROVE" loading={busy} onPress={onApprove} />
    </View>
  );
}

export default function OpeningBookScreen() {
  const storeModes = useGameStore((state) => state.modes);
  const tabs: ModeTab[] = storeModes.length > 0 ? storeModes : FALLBACK_MODES;
  const [modeId, setModeId] = useState<ModeID>('V3');
  const [bookData, setBookData] = useState<OpeningBookBootstrap | null>(null);
  const [line, setLine] = useState<OpeningLine>([]);
  // The book is a graph the server owns, so the screen keeps only what it has
  // actually looked at, keyed by the line that reached it. Seeded from the
  // bootstrap's featured openings, which is what makes those instant.
  const [nodes, setNodes] = useState<Map<string, OpeningNodeView>>(() => new Map());
  const [loading, setLoading] = useState(true);
  const [walking, setWalking] = useState(false);
  const [suggesting, setSuggesting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // Boards are drawn at a size in points, so the grid has to be measured
  // rather than flexed. Zero until the first layout, which is also what the
  // build-time render reports — see `useSettled` for why that matters.
  const [pageWidth, setPageWidth] = useState(0);

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

  useEffect(() => {
    setLine([]);
    load();
  }, [load]);

  const book = bookData;
  const names = bookData?.names ?? [];
  const node = nodes.get(lineKey(line)) ?? null;

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

  // Every board on the page comes from replaying the line locally, so they are
  // all drawn before the server has said anything about the position.
  const walk = useMemo(() => walkOpeningLine(mode, line), [mode, lineKey(line)]);
  const game: AnalysisGame | null = gameAfterWalk(walk);
  const lastStep = lastStepOfWalk(walk);

  const title = openingNameForLine(names, line);
  const exactName = exactOpeningName(names, line);
  const turn = sideOf(node?.turn ?? game?.currentTurn, line.length);

  const isWide = pageWidth >= WIDE_ENOUGH;
  const heroBoard = Math.round(
    Math.max(
      HERO_BOARD_MIN,
      Math.min(
        HERO_BOARD_MAX,
        isWide ? pageWidth * 0.38 : pageWidth - EVAL_BAR_COLUMN,
      ),
    ),
  );
  const cardWidth = cardWidthFor(pageWidth);

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
    setNotice(null);
  };

  const submitSuggestion = async (name: string) => {
    setSuggesting(true);
    setError(null);
    try {
      await suggestOpeningName(modeId, line, name);
      setNotice(`“${name}” was sent to the curators.`);
      return true;
    } catch (requestError) {
      setError(failureMessage(requestError));
      return false;
    } finally {
      setSuggesting(false);
    }
  };

  // A just-published name appears immediately rather than after a reload. The
  // tree itself is untouched, so there is nothing else to refetch.
  const publishLocally = (published: OpeningName) => {
    setBookData((current) =>
      current ? { ...current, names: mergeName(current.names, published) } : current,
    );
  };

  const measure = (event: LayoutChangeEvent) => setPageWidth(event.nativeEvent.layout.width);
  const forced = node ? forcedLabel(node.score) : null;

  const heroDiagram = game && pageWidth > 0 && (
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
              <Text style={styles.headerSubtitle}>A living book, analyzed by RPSFish and named by players.</Text>
            </View>
          </View>

          <View style={styles.modeTabs}>
            {tabs.map((candidate) => (
              <Pressable
                accessibilityRole="tab"
                accessibilityState={{ selected: candidate.id === modeId }}
                key={candidate.id}
                onPress={() => chooseMode(candidate.id)}
                style={({ pressed }) => [
                  styles.modeTab,
                  candidate.id === modeId && styles.modeTabActive,
                  pressed && styles.pressed,
                ]}
              >
                <Text style={[styles.modeTabCode, candidate.id === modeId && styles.modeTabCodeActive]}>
                  {candidate.shortCode ?? candidate.id}
                </Text>
                <Text style={[styles.modeTabName, candidate.id === modeId && styles.modeTabNameActive]}>
                  {candidate.name}
                </Text>
              </Pressable>
            ))}
          </View>

          <Banner message={error} onDismiss={() => setError(null)} tone="error" />
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
                  <Text style={styles.eyebrow}>BOOK IN PREPARATION</Text>
                  <Text style={styles.emptyTitle}>No {tab?.name ?? modeId} scan has been imported yet.</Text>
                  <Text style={styles.emptyCopy}>
                    This is the position it will start from. Run RPSFish’s book exporter, then use the curator studio below or upload the JSON directly to the admin endpoint.
                  </Text>
                </View>
              </View>
            </Panel>
          ) : (
            <>
              <Panel style={styles.hero} tone="accent">
                <View style={[styles.heroLayout, isWide && styles.heroLayoutWide]}>
                  {heroDiagram}
                  <View style={styles.heroCopy}>
                    <View style={styles.heroEyebrowRow}>
                      <Text style={styles.eyebrow}>{openingKind(line).toUpperCase()}</Text>
                      <View style={styles.turnTag}>
                        <TurnDot turn={turn} />
                        <Text style={styles.turnTagText}>{turn.toUpperCase()} TO MOVE</Text>
                      </View>
                    </View>
                    <Text style={styles.heroTitle}>{title.label}</Text>
                    {title.inherited && (
                      <Text style={styles.inheritanceCopy}>
                        Inherited from {title.namedAncestor?.name}; this last move can still earn its own variation name.
                      </Text>
                    )}
                    <View style={styles.heroMeta}>
                      {exactName ? <Badge label="PUBLISHED NAME" tone="gold" /> : <Badge label="NAME WANTED" />}
                      {forced && <Badge label={forced} tone="warm" />}
                      {node && <Badge label={`DEPTH ${node.depth}`} tone="accent" />}
                      {node && <Badge label={`${node.nodes.toLocaleString()} NODES`} />}
                    </View>
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

              {line.length === 0 && book.mainLine.length > 0 && (
                <Panel style={styles.mainLinePanel}>
                  <View style={styles.sectionHeader}>
                    <View style={styles.sectionHeaderCopy}>
                      <Text style={styles.eyebrow}>CORE OPENING</Text>
                      <Text style={styles.sectionTitle}>Main line</Text>
                    </View>
                    <Badge label={`${book.mainLine.length} PLIES`} tone="accent" />
                  </View>
                  <Text style={styles.sectionCopy}>
                    RPSFish’s best continuation through the analyzed graph, board by board. Tap any move to open that position.
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
                    <Text style={styles.eyebrow}>{line.length === 0 ? 'FIRST MOVES' : 'BEST RESPONSES'}</Text>
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
                      This line can still be named. A later engine import can add responses without losing that name.
                    </Text>
                  </Panel>
                ) : (
                  <View style={styles.moveGrid}>
                    {cardWidth > 0 &&
                      node.moves.map((candidate) => {
                        const childLine = [...line, candidate.move];
                        const childName = openingNameForLine(names, childLine);
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
                            turn={turn}
                            width={cardWidth}
                          />
                        );
                      })}
                  </View>
                )}
              </View>

              <NameForm
                busy={suggesting}
                inheritedFrom={title.namedAncestor}
                line={line}
                onSubmit={submitSuggestion}
                publishedName={exactName}
              />
            </>
          )}

          <AdminStudio
            names={names}
            line={line}
            mode={mode}
            modeId={modeId}
            onBookImported={load}
            onNamePublished={publishLocally}
            onNotice={setNotice}
          />
      </>
    </ScreenShell>
  );
}

const styles = StyleSheet.create({
  pressed: { opacity: 0.7 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  headerCopy: { flex: 1 },
  brand: { color: colors.accentBright, fontSize: 15, fontWeight: '900', letterSpacing: 1.2 },
  headerSubtitle: { color: colors.textMuted, fontSize: 11, marginTop: 2 },

  modeTabs: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  modeTab: {
    minWidth: 126,
    flexGrow: 1,
    flexBasis: 0,
    paddingHorizontal: 13,
    paddingVertical: 10,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.medium,
    backgroundColor: colors.surface,
  },
  modeTabActive: { borderColor: colors.accentBorder, backgroundColor: colors.accentSurfaceQuiet },
  modeTabCode: { color: colors.textFaint, fontSize: 8, fontWeight: '900', letterSpacing: 1 },
  modeTabCodeActive: { color: colors.accentBright },
  modeTabName: { color: colors.textMuted, fontSize: 12, fontWeight: '800', marginTop: 2 },
  modeTabNameActive: { color: colors.textStrong },

  loadingState: { alignItems: 'center', justifyContent: 'center', gap: 10, paddingVertical: 70 },
  loadingText: { color: colors.textMuted, fontSize: 12 },
  emptyBook: { paddingVertical: 26 },
  emptyRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: space.large },
  emptyCopyColumn: { flex: 1, minWidth: 240 },
  eyebrow: { color: colors.accentBright, fontSize: 8, fontWeight: '900', letterSpacing: 1.4 },
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
  turnDot: { width: 7, height: 7, borderRadius: 4 },
  heroTitle: { color: colors.textStrong, fontSize: 26, lineHeight: 32, fontWeight: '900', marginTop: 6 },
  heroMeta: { flexDirection: 'row', flexWrap: 'wrap', gap: 7, marginTop: 12 },
  heroActions: { flexDirection: 'row', gap: 8, marginTop: 12 },
  inheritanceCopy: { color: colors.textMuted, fontSize: 11, lineHeight: 17, marginTop: 8 },

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
  sectionHeader: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10 },
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
  moveGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: CARD_GAP },
  moveCard: {
    padding: CARD_PADDING,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.large,
    backgroundColor: colors.surface,
  },
  moveCardMain: { borderColor: colors.goldBorder },
  moveCardPressed: { borderColor: colors.accentBorder, backgroundColor: colors.accentSurfaceQuiet },
  moveBoard: { position: 'relative' },
  moveBoardMissing: {
    ...StyleSheet.absoluteFill,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 4,
    backgroundColor: colors.surfaceSunken,
  },
  moveBoardMissingText: { color: colors.textFaint, fontSize: 13, fontWeight: '900' },
  rankChip: {
    position: 'absolute',
    top: 5,
    left: 5,
    minWidth: 19,
    alignItems: 'center',
    paddingHorizontal: 4,
    paddingVertical: 2,
    borderRadius: radius.small,
    backgroundColor: colors.surfaceDeep,
  },
  rankNumber: { color: colors.textStrong, fontSize: 10, fontWeight: '900' },
  mainFlag: {
    position: 'absolute',
    top: 5,
    right: 5,
    paddingHorizontal: 5,
    paddingVertical: 2,
    borderRadius: radius.small,
    backgroundColor: colors.goldSurfaceDeep,
  },
  mainFlagText: { color: colors.goldBright, fontSize: 7, fontWeight: '900', letterSpacing: 0.8 },
  expectation: {
    position: 'relative',
    height: 6,
    marginTop: 9,
    overflow: 'hidden',
    borderRadius: 3,
    backgroundColor: colors.surfaceDeep,
  },
  expectationFill: { position: 'absolute', top: 0, bottom: 0, borderRadius: 3 },
  expectationCentre: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: '50%',
    width: 1,
    backgroundColor: colors.borderStrong,
  },
  moveHeadline: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 8 },
  moveNotation: { flex: 1, color: colors.textStrong, fontSize: 15, fontWeight: '900' },
  moveScore: { color: colors.textSubtle, fontSize: 11, fontWeight: '900', fontVariant: ['tabular-nums'] },
  moveScoreForced: { color: colors.goldBright, fontSize: 9 },
  moveName: { color: colors.accentSoft, fontSize: 11, fontWeight: '800', marginTop: 5 },
  moveNameWanted: { color: colors.goldSoft },
  moveStatus: { color: colors.textFaint, fontSize: 9, lineHeight: 13, marginTop: 4 },
  frontierPanel: { paddingVertical: 22 },
  frontierTitle: { color: colors.textStrong, fontSize: 14, fontWeight: '900' },
  frontierCopy: { color: colors.textMuted, fontSize: 11, lineHeight: 17, marginTop: 5 },

  namePanel: { marginTop: 2, padding: 18 },
  namePrompt: { color: colors.textStrong, fontSize: 17, fontWeight: '900', marginTop: 4 },
  nameHelp: { color: colors.textMuted, fontSize: 11, lineHeight: 17, marginTop: 5 },
  formRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 12 },
  textInput: {
    flex: 1,
    minHeight: 40,
    paddingHorizontal: 11,
    paddingVertical: 9,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    borderRadius: radius.medium,
    backgroundColor: colors.surfaceSunken,
    color: colors.textStrong,
    fontSize: 13,
  },

  adminWrap: { marginTop: 10 },
  curateLink: { alignSelf: 'center', paddingHorizontal: 12, paddingVertical: 9 },
  curateLinkText: { color: colors.textFaint, fontSize: 8, fontWeight: '900', letterSpacing: 1 },
  adminPanel: { marginTop: 4, padding: 18 },
  adminTitle: { color: colors.textStrong, fontSize: 18, fontWeight: '900', marginTop: 4 },
  adminHelp: { color: colors.textMuted, fontSize: 11, lineHeight: 17, marginTop: 5 },
  adminSections: { gap: 22, marginTop: 16 },
  fieldLabel: { color: colors.textMuted, fontSize: 8, fontWeight: '900', letterSpacing: 1, marginBottom: 6 },
  jsonInput: { minHeight: 130, marginBottom: 8, fontFamily: 'monospace', fontSize: 10 },
  suggestionHeading: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  suggestionList: { gap: 7 },
  suggestionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    padding: 10,
    borderRadius: radius.medium,
    backgroundColor: colors.surfaceSunken,
  },
  suggestionCopy: { flex: 1, minWidth: 0 },
  suggestionName: { color: colors.textStrong, fontSize: 12, fontWeight: '900' },
  suggestionLine: { color: colors.textFaint, fontSize: 9, marginTop: 3 },
});
