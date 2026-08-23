import { useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import {
  exactOpeningName,
  nodeAtLine,
  openingKind,
  openingNameForLine,
  validateOpeningBookDocument,
  type OpeningBookDocument,
  type OpeningLine,
  type OpeningName,
  type OpeningNameSuggestion,
  type PublishedOpeningBook,
} from '@/engine/openingBook';
import { failureMessage } from '@/errors';
import { useAdminToken } from '@/hooks/useAdminToken';
import { ApiError } from '@/store/api/http';
import { links } from '@/navigation/links';
import {
  approveOpeningNameSuggestion,
  getOpeningBook,
  getOpeningNameSuggestions,
  importOpeningBook,
  setOpeningName,
  suggestOpeningName,
} from '@/store/api/openings';
import { useGameStore } from '@/store/gameStore';
import { colors, players, radius, WIDE_LAYOUT_WIDTH } from '@/theme';
import type { ModeID } from '@/types/game';
import { Badge, Banner, GhostButton, Panel, PrimaryButton } from '@/ui/primitives';

/** Enough of a mode to label a tab, for before the server catalog arrives. */
interface ModeTab {
  id: ModeID;
  name: string;
  shortCode: string;
}

const FALLBACK_MODES: ModeTab[] = [
  { id: 'V3', name: 'Infiltration', shortCode: 'V3' },
  { id: 'V1', name: 'Annihilation', shortCode: 'V1' },
  { id: 'V5', name: 'Total War', shortCode: 'V5' },
];

const formatScore = (score: number) => {
  if (score >= 900_000) return 'FORCED WIN';
  if (score <= -900_000) return 'FORCED LOSS';
  return `${score >= 0 ? '+' : ''}${score}`;
};

const mergeName = (
  names: OpeningName[] | null | undefined,
  published: OpeningName,
): OpeningName[] => [
  ...(names ?? []).filter(
    (candidate) => candidate.line.join(' ') !== published.line.join(' '),
  ),
  published,
];

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
  bookData: PublishedOpeningBook | null;
  line: OpeningLine;
  modeId: ModeID;
  onBookImported: (book: PublishedOpeningBook) => void;
  onNamePublished: (name: OpeningName) => void;
  onNotice: (message: string) => void;
}

function AdminStudio({
  bookData,
  line,
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
  const published = exactOpeningName(bookData?.names, line);

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
      onBookImported(imported);
      onNotice(`Imported ${imported.book.positionCount.toLocaleString()} analyzed positions.`);
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
                      <View key={suggestion.suggestionId} style={styles.suggestionRow}>
                        <View style={styles.suggestionCopy}>
                          <Text style={styles.suggestionName}>{suggestion.name}</Text>
                          <Text style={styles.suggestionLine}>{suggestion.line.join('  ')}</Text>
                        </View>
                        <PrimaryButton
                          compact
                          label="APPROVE"
                          loading={busy === `approve-${suggestion.suggestionId}`}
                          onPress={() => approve(suggestion)}
                        />
                      </View>
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

export default function OpeningBookScreen() {
  const router = useRouter();
  const storeModes = useGameStore((state) => state.modes);
  const modes = storeModes.length > 0 ? storeModes : FALLBACK_MODES;
  const [modeId, setModeId] = useState<ModeID>('V3');
  const [bookData, setBookData] = useState<PublishedOpeningBook | null>(null);
  const [line, setLine] = useState<OpeningLine>([]);
  const [loading, setLoading] = useState(true);
  const [suggesting, setSuggesting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const mode = modes.find((candidate) => candidate.id === modeId) ?? modes[0];

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setBookData(await getOpeningBook(modeId));
    } catch (requestError) {
      // A mode with no book yet is not a failure; it is the empty state.
      if (requestError instanceof ApiError && requestError.status === 404) setBookData(null);
      else setError(failureMessage(requestError));
    } finally {
      setLoading(false);
    }
  }, [modeId]);

  useEffect(() => {
    setLine([]);
    load();
  }, [load]);

  const book = bookData?.book ?? null;
  const names = bookData?.names ?? [];
  const node = useMemo(() => nodeAtLine(book?.root, line), [book?.root, line]);
  const title = openingNameForLine(names, line);
  const exactName = exactOpeningName(names, line);
  const turn = node?.turn ?? (line.length % 2 === 0 ? 'Red' : 'Blue');

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

  return (
    <SafeAreaView style={styles.safeArea} edges={['top', 'right', 'bottom', 'left']}>
      <ScrollView
        contentContainerStyle={styles.scrollContent}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.screen}>
          <View style={styles.header}>
            <GhostButton compact label="← LOBBY" onPress={() => router.push(links.lobby())} />
            <View style={styles.headerCopy}>
              <Text style={styles.brand}>RPS OPENINGS</Text>
              <Text style={styles.headerSubtitle}>A living book, analyzed by RPSFish and named by players.</Text>
            </View>
          </View>

          <View style={styles.modeTabs}>
            {modes.map((candidate) => (
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
              <Text style={styles.loadingText}>Opening the {mode?.name ?? modeId} book…</Text>
            </View>
          ) : !book ? (
            <Panel style={styles.emptyBook} tone="accent">
              <Text style={styles.eyebrow}>BOOK IN PREPARATION</Text>
              <Text style={styles.emptyTitle}>No {mode?.name ?? modeId} scan has been imported yet.</Text>
              <Text style={styles.emptyCopy}>
                The shelf is ready. Run RPSFish’s book exporter, then use the curator studio below or upload the JSON directly to the admin endpoint.
              </Text>
            </Panel>
          ) : (
            <>
              <Panel style={styles.hero} tone="accent">
                <View style={styles.heroTop}>
                  <View style={styles.heroCopy}>
                    <Text style={styles.eyebrow}>
                      {openingKind(line).toUpperCase()} · {turn.toUpperCase()} TO MOVE
                    </Text>
                    <Text style={styles.heroTitle}>{title.label}</Text>
                    {line.length > 0 && <Text style={styles.heroLine}>{line.join('  ')}</Text>}
                  </View>
                  {line.length > 0 && (
                    <GhostButton
                      compact
                      label="← BACK"
                      onPress={() => setLine((current) => current.slice(0, -1))}
                    />
                  )}
                </View>
                <View style={styles.heroMeta}>
                  {exactName ? <Badge label="PUBLISHED NAME" tone="gold" /> : <Badge label="NAME WANTED" />}
                  {node && <Badge label={`DEPTH ${node.depth}`} tone="accent" />}
                  {node && <Badge label={`${node.nodes.toLocaleString()} NODES`} />}
                </View>
                {title.inherited && (
                  <Text style={styles.inheritanceCopy}>
                    Inherited from {title.namedAncestor?.name}; this last move can still earn its own variation name.
                  </Text>
                )}
              </Panel>

              {line.length === 0 && book.mainLine.length > 0 && (
                <Panel style={styles.mainLinePanel}>
                  <View style={styles.sectionHeader}>
                    <View>
                      <Text style={styles.eyebrow}>CORE OPENING</Text>
                      <Text style={styles.sectionTitle}>Main line</Text>
                    </View>
                    <Badge label={`${book.mainLine.length} PLIES`} tone="accent" />
                  </View>
                  <Text style={styles.sectionCopy}>
                    RPSFish’s best continuation through the analyzed graph. Tap any move to open that position.
                  </Text>
                  <View style={styles.mainLineMoves}>
                    {book.mainLine.map((move, index) => (
                      <Pressable
                        accessibilityLabel={`Open main line after ${move}`}
                        key={`${index}-${move}`}
                        onPress={() => setLine(book.mainLine.slice(0, index + 1))}
                        style={({ pressed }) => [styles.mainLineMove, pressed && styles.pressed]}
                      >
                        <Text style={styles.mainLineNumber}>{index + 1}</Text>
                        <Text style={styles.mainLineNotation}>{move}</Text>
                      </Pressable>
                    ))}
                  </View>
                </Panel>
              )}

              <View style={styles.moveSection}>
                <View style={styles.sectionHeader}>
                  <View>
                    <Text style={styles.eyebrow}>{line.length === 0 ? 'FIRST MOVES' : 'BEST RESPONSES'}</Text>
                    <Text style={styles.sectionTitle}>
                      {node?.moves?.length ? `${turn}’s book choices` : 'End of the imported line'}
                    </Text>
                  </View>
                  {node && <Badge label={formatScore(node.score)} tone={node.score >= 0 ? 'accent' : 'warm'} />}
                </View>
                {!node?.moves?.length ? (
                  <Panel style={styles.frontierPanel}>
                    <Text style={styles.frontierTitle}>The scan stops here for now.</Text>
                    <Text style={styles.frontierCopy}>
                      This line can still be named. A later engine import can add responses without losing that name.
                    </Text>
                  </Panel>
                ) : (
                  <View style={styles.moveList}>
                    {node.moves.map((move) => {
                      const childLine = [...line, move.move];
                      const childName = openingNameForLine(names, childLine);
                      return (
                        <Pressable
                          accessibilityLabel={`Explore ${move.move}, ${childName.label}`}
                          accessibilityRole="button"
                          key={move.move}
                          onPress={() => setLine(childLine)}
                          style={({ pressed }) => [styles.moveRow, pressed && styles.moveRowPressed]}
                        >
                          <View style={styles.rankBox}>
                            <Text style={styles.rankNumber}>{move.rank}</Text>
                          </View>
                          <View style={styles.moveCopy}>
                            <View style={styles.moveTitleRow}>
                              <Text style={styles.moveNotation}>{move.move}</Text>
                              {move.mainLine && <Badge label="MAIN" tone="gold" />}
                            </View>
                            <Text style={[styles.moveName, childName.suggestionNeeded && styles.moveNameWanted]}>
                              {childName.label}
                            </Text>
                            <Text style={styles.moveStatus}>
                              {move.repetition
                                ? 'Repetition · branch rejoins the book'
                                : move.child
                                  ? `${move.child.turn} response · searched to depth ${move.child.depth}`
                                  : move.searched
                                    ? 'Analyzed transposition · continue from its named line'
                                    : 'Frontier · waiting for a deeper scan'}
                            </Text>
                          </View>
                          <View style={styles.moveScoreBox}>
                            <Text style={styles.moveScore}>{formatScore(move.score)}</Text>
                            <Text style={styles.exploreArrow}>→</Text>
                          </View>
                        </Pressable>
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
            bookData={bookData}
            line={line}
            modeId={modeId}
            onBookImported={load}
            onNamePublished={publishLocally}
            onNotice={setNotice}
          />
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: colors.background },
  scrollContent: { flexGrow: 1 },
  screen: {
    width: '100%',
    maxWidth: WIDE_LAYOUT_WIDTH,
    alignSelf: 'center',
    paddingHorizontal: 18,
    paddingTop: 16,
    paddingBottom: 70,
    gap: 14,
  },
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
  eyebrow: { color: colors.accentBright, fontSize: 8, fontWeight: '900', letterSpacing: 1.4 },
  emptyTitle: { color: colors.textStrong, fontSize: 22, fontWeight: '900', marginTop: 7 },
  emptyCopy: { color: colors.textMuted, fontSize: 12, lineHeight: 19, marginTop: 8, maxWidth: 680 },

  hero: { padding: 20 },
  heroTop: { flexDirection: 'row', alignItems: 'flex-start', gap: 12 },
  heroCopy: { flex: 1 },
  heroTitle: { color: colors.textStrong, fontSize: 28, lineHeight: 34, fontWeight: '900', marginTop: 5 },
  heroLine: { color: colors.accentText, fontSize: 12, lineHeight: 19, marginTop: 7 },
  heroMeta: { flexDirection: 'row', flexWrap: 'wrap', gap: 7, marginTop: 14 },
  inheritanceCopy: { color: colors.textMuted, fontSize: 11, lineHeight: 17, marginTop: 11 },

  mainLinePanel: { padding: 18 },
  sectionHeader: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10 },
  sectionTitle: { color: colors.textStrong, fontSize: 20, fontWeight: '900', marginTop: 3 },
  sectionCopy: { color: colors.textMuted, fontSize: 11, lineHeight: 17, marginTop: 7 },
  mainLineMoves: { flexDirection: 'row', flexWrap: 'wrap', gap: 7, marginTop: 14 },
  mainLineMove: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: colors.borderStrong,
    borderRadius: radius.small,
    backgroundColor: colors.surfaceSunken,
    overflow: 'hidden',
  },
  mainLineNumber: { color: colors.textFaint, fontSize: 8, paddingHorizontal: 6 },
  mainLineNotation: {
    color: colors.textStrong,
    fontSize: 12,
    fontWeight: '900',
    paddingHorizontal: 8,
    paddingVertical: 7,
    borderLeftWidth: 1,
    borderLeftColor: colors.border,
  },

  moveSection: { gap: 10 },
  moveList: { gap: 8 },
  moveRow: {
    minHeight: 88,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: 12,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.large,
    backgroundColor: colors.surface,
  },
  moveRowPressed: { borderColor: colors.accentBorder, backgroundColor: colors.accentSurfaceQuiet },
  rankBox: {
    width: 38,
    height: 38,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 19,
    backgroundColor: colors.surfaceMuted,
  },
  rankNumber: { color: colors.textStrong, fontSize: 15, fontWeight: '900' },
  moveCopy: { flex: 1, minWidth: 0 },
  moveTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  moveNotation: { color: colors.textStrong, fontSize: 16, fontWeight: '900' },
  moveName: { color: colors.accentSoft, fontSize: 12, fontWeight: '800', marginTop: 4 },
  moveNameWanted: { color: colors.goldSoft },
  moveStatus: { color: colors.textFaint, fontSize: 10, marginTop: 4 },
  moveScoreBox: { alignItems: 'flex-end', gap: 5 },
  moveScore: { color: colors.textSubtle, fontSize: 11, fontWeight: '900' },
  exploreArrow: { color: colors.accentBright, fontSize: 19, fontWeight: '900' },
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
  suggestionCopy: { flex: 1 },
  suggestionName: { color: colors.textStrong, fontSize: 12, fontWeight: '900' },
  suggestionLine: { color: colors.textFaint, fontSize: 9, marginTop: 3 },
});
