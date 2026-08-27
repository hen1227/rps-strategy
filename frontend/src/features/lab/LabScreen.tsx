import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Animated,
  Easing,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  useWindowDimensions,
} from 'react-native';

import { Link } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';

import { AgentAsk, AgentProposal } from './AgentAsk';
import BoardStage from './BoardStage';
import Inspector from './Inspector';
import ChatComposer from './ChatComposer';
import ChatRail, { ToolsPill } from './ChatRail';
import ExportSheet from './ExportSheet';
import KeySheet from './KeySheet';
import OpeningPrompt from './OpeningPrompt';
import { allValidMoves, validMovesFor } from '@/engine/analysisGame';
import { validateSpec } from '@/engine/spec/validate';
import { labTools, type LabController } from './tools';
import { LAB_ENABLED } from '@/featureFlags';
import { useSettled } from '@/hooks/useSettled';
import { useBoardLayout, useWideLayout } from '@/hooks/useBoardLayout';
import { useSettledSearchParams } from '@/navigation/useSettledSearchParams';
import { links } from '@/navigation/links';
import { SITE_URL } from '@/store/serverConfig';
import { useLabStore } from '@/store/labSession';
import { describeSpecChange } from './agent/specDiff';
import { useLabChat, watchExternalCalls } from '@/store/labChat';
import {
  addLabArt,
  getLanguageReference,
  getLibraryMode,
  getRulePart,
  listDrafts,
  listLabArt,
  listRuleParts,
  publishMode,
  publishRulePart,
  saveDraft,
} from '@/store/api/lab';
import { useRequestIdentity } from '@/hooks/useRequestIdentity';
import { colors, contentWidth, radius, space, type } from '@/theme';
import { Banner, GhostButton, Panel, PrimaryButton, SectionHeading } from '@/ui/primitives';
import ModalCard from '@/ui/ModalCard';
import ScreenShell from '@/ui/ScreenShell';
import { callTool, describeFlavour, type CallOptions } from '@/webmcp/modelContext';
import { useModelContextTools } from '@/webmcp/useModelContextTools';
import type { RuleSpec } from '@/engine/spec/types';

// The RPS Lab: describe a game, watch it get built, play it, publish it.
//
// Chat-first, and the layout says so. You arrive at one prompt on an empty
// stage; the moment you have said something the prompt becomes a rail down the
// left and a live board takes the middle. Everything else — whether the rules
// parse, what the playtest found, whose turn it is — is one strip under the
// board rather than a column of panels, because a panel that is empty most of
// the time teaches you to stop looking at it.
//
// The agent is an ordinary WebMCP client. It reads its tools from
// `document.modelContext` and calls them through `callTool`, which is the same
// door Chrome's agent comes through — there is no faster private path, on
// purpose, because a private path is one that can work while the public one is
// broken. A call from somebody else's agent lands in this rail too.
//
// State is `labSession` for the mode and `labChat` for the conversation, and
// neither is `gameStore`: `SessionBridge` sends the browser to `/play` whenever
// a game is in that store, so a Lab that put its test game there would redirect
// itself away the moment somebody started one.

export default function LabScreen() {
  const settled = useSettled();
  // One gate, read at module scope so the export inlines it: a build with the
  // Lab off ships the page and the page says so, rather than shipping a
  // workbench whose publish button reaches a server that will not take it.
  if (!LAB_ENABLED) return <LabUnavailable />;
  if (!settled) return <LabPlaceholder />;
  return <Lab />;
}

function LabUnavailable() {
  return (
    <ScreenShell width={contentWidth.reading}>
      <Panel>
        <SectionHeading eyebrow="RPS LAB" title="Not open yet" />
        <Text style={styles.muted}>
          The workbench for designing your own game modes is still being built. It will let you
          invent a game with an agent, play it, and publish it for other people to try.
        </Text>
      </Panel>
    </ScreenShell>
  );
}

/**
 * The first render, which also runs in Node when the site is exported.
 *
 * It must not read the window, the query string or storage — the build has none
 * of them, and disagreeing with it throws the pre-rendered page away. The inner
 * component is where all of that happens, and splitting it is what keeps the
 * hook count the same across both renders.
 */
function LabPlaceholder() {
  return (
    <ScreenShell width={contentWidth.page}>
      <Panel>
        <SectionHeading eyebrow="RPS LAB" title="Design a game" />
        <Text style={styles.muted}>Loading the workbench…</Text>
      </Panel>
    </ScreenShell>
  );
}

function Lab() {
  const { params } = useSettledSearchParams<{ fork?: string }>();
  const forkId = typeof params.fork === 'string' ? params.fork : null;

  const draft = useLabStore((state) => state.draft);
  const report = useLabStore((state) => state.report);
  const game = useLabStore((state) => state.game);
  const pendingPrompt = useLabStore((state) => state.pendingPrompt);
  const pendingProposal = useLabStore((state) => state.pendingProposal);
  const simulation = useLabStore((state) => state.simulation);
  const spotlight = useLabStore((state) => state.spotlight);
  const publishedModeId = useLabStore((state) => state.publishedModeId);
  const publishError = useLabStore((state) => state.publishError);

  const items = useLabChat((state) => state.items);
  const run = useLabChat((state) => state.run);
  const source = useLabChat((state) => state.source);
  const apiKey = useLabChat((state) => state.apiKey);

  // Who is asking: a login when there is one, this browser's own account
  // otherwise. Publishing is deliberately open to a guest.
  const identity = useRequestIdentity();

  const [rawOpen, setRawOpen] = useState(false);
  const [rawText, setRawText] = useState('');
  const [rawError, setRawError] = useState<string | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [keyOpen, setKeyOpen] = useState(false);
  const [publishedUrl, setPublishedUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pane, setPane] = useState<'chat' | 'board' | 'rules'>('chat');

  const wide = useWideLayout();
  const { width } = useWindowDimensions();
  // Three columns — the conversation, the board, the rules — need room the
  // two-column breakpoint does not promise. At 900px the rules would take the
  // board's width rather than the empty space, so below this they go under the
  // board instead, where the board is still the thing above them.
  const threeColumn = wide && width >= 1280;
  const { boardSize } = useBoardLayout({
    sidePanel: threeColumn ? 860 : 460,
    chrome: 280,
  });

  /**
   * The controller the tools run against.
   *
   * One object, built from the store, and the page's own buttons go through it
   * too. That is the whole reason it exists: a mode built by pressing buttons
   * and a mode built by an agent are then the same mode, made the same way.
   */
  const controller = useMemo<LabController>(() => {
    const store = useLabStore.getState;
    return {
      getDraft: () => store().draft,
      setDraft: (spec) => store().setDraft(spec),
      validate: (spec) => validateSpec(spec),
      getGame: () => store().game,
      newGame: (options) => store().newGame(options),
      endGame: () => store().endGame(),
      legalMoves: (from) => {
        const current = store().game;
        if (!current) return [];
        if (!from) return allValidMoves(current);
        return validMovesFor(current, from).map((to) => ({ from, to }));
      },
      play: (from, to) => store().play(from, to),
      undo: () => store().undo(),
      simulate: (options) => store().runSimulation(options),
      getSimulation: () => store().simulation,
      language: () => getLanguageReference(),
      searchParts: async (options) =>
        (await listRuleParts({ kind: options.kind, search: options.search })).parts,
      getPart: async (partId) => {
        try {
          return (await getRulePart(partId)).part;
        } catch {
          return null;
        }
      },
      publishMode: async (input) => {
        const { mode: published } = await publishMode(
          { slug: input.slug, spec: store().draft, visibility: input.visibility },
          identity,
        );
        store().setPublished(published.modeId);
        const url = `${SITE_URL}/library?mode=${published.modeId}`;
        setPublishedUrl(url);
        return { modeId: published.modeId, url };
      },
      publishPart: async (input) => {
        const { part } = await publishRulePart(
          {
            partId: input.partId,
            kind: input.kind,
            name: input.name,
            summary: input.summary,
            body: input.body,
          },
          identity,
        );
        return { partId: part.partId, version: part.version };
      },
      // A session token, not a profile key: uploading is the one thing in the
      // Lab that needs a real account, because it is the one thing the Lab makes
      // that the server then hosts and serves to strangers.
      canAddImage: () => identity.sessionToken !== null,
      addImage: async (input) => (await addLabArt(input, identity)).art,
      listImages: async () => (await listLabArt(identity)).art.map((entry) => entry.art),
      saveDraft: async (name) => {
        const draftId = `${identity.userId}-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`.slice(0, 60);
        await saveDraft({ draftId, name, spec: store().draft }, identity);
        return { draftId };
      },
      listDrafts: async () =>
        (await listDrafts(identity)).drafts.map((entry) => ({
          draftId: entry.draftId,
          name: entry.name,
        })),
      loadDraft: async (draftId) =>
        (await listDrafts(identity)).drafts.find((entry) => entry.draftId === draftId)?.spec ?? null,
      confirm: (message, signal) => store().askToConfirm(message, signal),
      ask: (prompt, signal) => store().ask(prompt, signal),
      propose: (proposal, signal) => store().propose(proposal, signal),
      highlight: (spotlightInput) => store().setSpotlight(spotlightInput),
      activity: () => store().transcript,
    };
  }, [identity]);

  // The tool list changes with the page — there is no `lab_play_move` until
  // there is a game — so it is rebuilt whenever the thing it depends on moves.
  //
  // Every tool is wrapped so that *whoever* calls it lands in the transcript,
  // labelled with who that was: the page's own agent, an outside one through
  // `document.modelContext`, or a button here. Doing it at this level rather
  // than inside the chat is what lets the rail show an outside agent's work.
  const tools = useMemo(
    () =>
      labTools(controller).map((tool) => ({
        ...tool,
        execute: async (input: Record<string, unknown>, options?: CallOptions) => {
          // Read either side of the call so the transcript can carry *what
          // changed* rather than only that something did. By the time anything
          // reads a transcript entry the "before" is gone, so the diff has to be
          // taken here or not at all — and it is what the rail draws and what
          // the agent is told about the person's work.
          const before = useLabStore.getState().draft;
          try {
            const outcome = await tool.execute(input, options);
            const summary =
              typeof (outcome as { summary?: unknown })?.summary === 'string'
                ? ((outcome as { summary: string }).summary)
                : JSON.stringify(outcome);
            useLabStore.getState().record({
              tool: tool.name,
              input,
              summary,
              ok: true,
              origin: options?.origin,
              changes: describeSpecChange(before, useLabStore.getState().draft),
            });
            return outcome;
          } catch (error) {
            useLabStore.getState().record({
              tool: tool.name,
              input,
              summary: error instanceof Error ? error.message : String(error),
              ok: false,
              origin: options?.origin,
              changes: describeSpecChange(before, useLabStore.getState().draft),
            });
            throw error;
          }
        },
      })),
    // `game !== null` rather than `game`: the surface changes when a game starts
    // or stops, not on every move it goes through.
    [controller, game !== null],
  );
  const { flavour, tools: registered } = useModelContextTools(tools);
  const toolCount = registered.length || tools.length;

  // The chat needs to know who is asking, whether this server can run an agent,
  // and about calls it did not make.
  useEffect(() => {
    useLabChat.getState().setIdentity(identity);
  }, [identity]);
  useEffect(() => {
    watchExternalCalls();
    void useLabChat.getState().discoverSource();
  }, []);

  // Forking: `/lab?fork=custom:jumpers@1` opens somebody else's mode to edit.
  useEffect(() => {
    if (!forkId) return;
    let cancelled = false;
    void (async () => {
      try {
        const { mode: found } = await getLibraryMode(forkId);
        if (cancelled) return;
        useLabStore.getState().setDraft({ ...found.spec, name: `${found.spec.name} (fork)` });
        useLabStore.getState().record({
          tool: 'fork',
          input: { modeId: forkId },
          summary: `Opened ${found.name} by ${found.ownerUsername || 'somebody'} to edit.`,
          ok: true,
          origin: 'you',
        });
      } catch {
        // A fork of something that is not there leaves the starting draft, which
        // is a working mode — better than an empty page and an error.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [forkId]);

  const started = items.length > 0;

  // The stage fades up the first time there is something to show. Opacity and
  // transform only, on the native driver: `width` is not native-driver safe on
  // react-native-web, and animating the columns apart janks visibly.
  const entrance = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!started) return;
    Animated.timing(entrance, {
      toValue: 1,
      duration: 320,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();
  }, [entrance, started]);

  const send = useCallback((text: string) => {
    const chat = useLabChat.getState();
    if (chat.source.kind === 'none' && !chat.apiKey) {
      setKeyOpen(true);
      return;
    }
    chat.send(text);
  }, []);

  const openRaw = () => {
    setRawText(JSON.stringify(draft, null, 2));
    setRawError(null);
    setRawOpen(true);
  };

  const applyRaw = () => {
    try {
      const parsed = JSON.parse(rawText) as RuleSpec;
      const result = useLabStore.getState().setDraft(parsed);
      setRawOpen(false);
      useLabStore.getState().record({
        tool: 'edit_json',
        input: {},
        summary:
          result.errors.length === 0
            ? 'Edited the rules by hand: valid.'
            : `Edited the rules by hand: ${result.errors.length} error(s).`,
        ok: result.errors.length === 0,
        origin: 'you',
      });
    } catch (error) {
      setRawError(error instanceof Error ? error.message : 'That is not valid JSON.');
    }
  };

  const playable = report.errors.length === 0;
  const running = run !== null && run.endedAtMs === null;
  const needsKey = source.kind === 'none' && !apiKey;
  const stageSize = wide
    ? Math.min(boardSize, 480)
    : Math.min(width - space.large * 2, 380);

  const composer = (
    <View style={styles.composerWrap}>
      <ChatComposer
        onSend={send}
        onStop={() => useLabChat.getState().stop()}
        running={running}
        placeholder={running ? 'Add something…' : 'What should change?'}
        footer={
          needsKey ? (
            <Pressable accessibilityRole="button" onPress={() => setKeyOpen(true)}>
              <Text style={styles.keyPrompt}>Connect an OpenAI key →</Text>
            </Pressable>
          ) : (
            <ToolsPill count={toolCount} detail={describeFlavour(flavour)} />
          )
        }
      />
    </View>
  );

  /**
   * The agent, waiting on a person.
   *
   * In the rail rather than in a modal over the board, and that is the whole
   * point of the shape: a modal is right for "are you sure", which is a stop,
   * and these are a turn in a conversation. Keeping the board visible matters
   * most for a proposal — the reason to offer a change rather than make it is so
   * somebody can look at it first.
   *
   * The tool call that asked is still in flight while this is on screen.
   */
  const waiting = pendingProposal ? (
    <View style={styles.waiting}>
      <AgentProposal
        onAnswer={(applied, text) => useLabStore.getState().answerProposal(applied, text)}
        proposal={pendingProposal}
      />
    </View>
  ) : pendingPrompt ? (
    <View style={styles.waiting}>
      <AgentAsk
        onAnswer={(answer) => useLabStore.getState().answerPrompt(answer)}
        prompt={pendingPrompt}
      />
    </View>
  ) : null;

  const rail = (
    <View style={[styles.rail, wide ? styles.railWide : styles.railFull]}>
      <ChatRail items={items} run={run} />
      {waiting}
      {composer}
    </View>
  );

  /**
   * Everything the board cannot draw: the kinds, the beats graph, the moves and
   * the win conditions.
   *
   * Built once and placed twice — its own column when there is room for one, and
   * under the board when there is not. Never behind a button: a panel you have
   * to open before it shows you anything is a panel most people never open.
   */
  const inspector = (
    <Inspector
      onPatch={(patch, what) => {
        void callTool('lab_patch_spec', { patch }, { origin: 'you' });
        void what;
      }}
      onSpotlight={(spot) =>
        useLabStore
          .getState()
          .setSpotlight(
            spot
              ? {
                  squares: [],
                  piece: spot.piece ?? null,
                  path: spot.path ?? null,
                  note: spot.note,
                }
              : null,
          )
      }
      simulation={simulation}
      spec={draft}
      spotlight={spotlight}
    />
  );

  const stage = (
    <ScrollView
      style={styles.stageScroll}
      contentContainerStyle={styles.stageContent}
      keyboardShouldPersistTaps="handled"
    >
      <BoardStage size={stageSize} entrance={entrance} />
      {wide && !threeColumn ? <View style={styles.stageInspector}>{inspector}</View> : null}
    </ScrollView>
  );

  return (
    <SafeAreaView edges={['top', 'bottom']} style={styles.page}>
      {started ? (
        <>
          <View style={styles.header}>
            <Text style={styles.headerEyebrow}>RPS LAB</Text>
            <Text style={styles.headerName} numberOfLines={1}>
              {draft.name}
            </Text>
            <View style={styles.headerActions}>
              <Link href={links.library()} style={styles.headerLink}>
                LIBRARY
              </Link>
              <GhostButton label="JSON" onPress={openRaw} />
              <PrimaryButton
                label="EXPORT"
                disabled={!playable}
                onPress={() => setExportOpen(true)}
              />
            </View>
          </View>

          {/* Two layouts, not one that stretches: on a phone the board and the
              conversation each want the whole window, so they take turns. */}
          {wide ? (
            <View style={styles.columns}>
              {rail}
              <View style={styles.stageColumn}>{stage}</View>
              {threeColumn ? (
                <View style={styles.inspectorColumn}>{inspector}</View>
              ) : null}
            </View>
          ) : (
            <>
              {/* Three panes rather than a sheet over the board. A phone cannot
                  fit the desktop layout, and the answer to that is to let a tab
                  press be the way to the detail — not a popup, which is a panel
                  most people never open. */}
              <View style={styles.tabs}>
                {(['chat', 'board', 'rules'] as const).map((option) => (
                  <Pressable
                    accessibilityRole="tab"
                    // Tabs, and which one is open. They were buttons with no
                    // state, which reads to a screen reader as three unrelated
                    // controls — and leaves `RULES` here indistinguishable from
                    // the `RULES` button in the header.
                    aria-selected={pane === option}
                    key={option}
                    onPress={() => setPane(option)}
                    style={[styles.tab, pane === option && styles.tabOn]}
                  >
                    <Text style={[styles.tabText, pane === option && styles.tabTextOn]}>
                      {option.toUpperCase()}
                    </Text>
                  </Pressable>
                ))}
              </View>
              {pane === 'chat' ? rail : pane === 'board' ? stage : inspector}
            </>
          )}
        </>
      ) : (
        <OpeningPrompt
          onSend={send}
          toolCount={toolCount}
          toolDetail={describeFlavour(flavour)}
          needsKey={needsKey}
          onConnectKey={() => setKeyOpen(true)}
        />
      )}

      <ExportSheet
        visible={exportOpen}
        canAddImage={controller.canAddImage()}
        onAddImage={async (input) => {
          const asset = await controller.addImage(input);
          // Recorded the way `edit_json` and `fork` are, so the agent reads what
          // the person chose out of the transcript it is already reading rather
          // than having to be told, or having to go looking.
          useLabStore.getState().record({
            tool: 'pick_art',
            input: { role: input.role },
            summary: `Chose a cover: ${asset.artId}. It is on the mode already.`,
            ok: true,
            origin: 'you',
          });
          return asset.artId;
        }}
        onClose={() => setExportOpen(false)}
        onPublish={async (input) => {
          setBusy(true);
          try {
            const published = await controller.publishMode(input);
            useLabStore.getState().record({
              tool: 'publish',
              input,
              summary: `Published as ${published.modeId}.`,
              ok: true,
              origin: 'you',
            });
          } catch (error) {
            useLabStore
              .getState()
              .setPublished(null, error instanceof Error ? error.message : 'Could not publish.');
          } finally {
            setBusy(false);
          }
        }}
        onSaveDraft={async (name) => {
          setBusy(true);
          try {
            await controller.saveDraft(name);
          } finally {
            setBusy(false);
          }
        }}
        publishedModeId={publishedModeId}
        publishedUrl={publishedUrl}
        publishError={publishError}
        busy={busy}
      />

      <KeySheet
        visible={keyOpen}
        onClose={() => setKeyOpen(false)}
        onSave={(key, model, remember) => useLabChat.getState().setApiKey(key, model, remember)}
        onForget={() => useLabChat.getState().forgetApiKey()}
        hasKey={apiKey !== null}
      />

      <ModalCard
        eyebrow="THE DOCUMENT"
        onClose={() => setRawOpen(false)}
        title="The mode, as a document"
        subtitle="This is exactly what gets published, and what the agent edits."
        maxWidth={720}
        visible={rawOpen}
        footer={
          <>
            <GhostButton label="CANCEL" onPress={() => setRawOpen(false)} />
            <PrimaryButton label="APPLY" onPress={applyRaw} />
          </>
        }
      >
        {rawError ? <Banner message={rawError} tone="error" /> : null}
        <ScrollView style={styles.rawScroll}>
          <TextInput
            accessibilityLabel="The mode as JSON"
            multiline
            onChangeText={setRawText}
            style={styles.raw}
            value={rawText}
          />
        </ScrollView>
      </ModalCard>

    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  page: { backgroundColor: colors.background, flex: 1 },

  header: {
    alignItems: 'center',
    borderBottomColor: colors.borderSoft,
    borderBottomWidth: 1,
    flexDirection: 'row',
    gap: space.small,
    paddingHorizontal: space.medium,
    paddingVertical: space.small,
  },
  headerEyebrow: { ...type.eyebrow, color: colors.accentText },
  headerName: { ...type.rowTitle, color: colors.text, flex: 1, minWidth: 0 },
  headerActions: { alignItems: 'center', flexDirection: 'row', gap: space.small },
  headerLink: { ...type.label, color: colors.textMuted },

  columns: { flex: 1, flexDirection: 'row', minHeight: 0 },
  rail: { minHeight: 0, minWidth: 0 },
  railFull: { flex: 1 },
  // A fixed rail, spelled out rather than written `flex: 0`: on
  // react-native-web that shorthand becomes CSS `flex: 0 1 0%`, and a
  // `flex-basis` of zero beats an explicit width on a flex item — the rail
  // collapses to the width of its longest unbreakable word.
  railWide: {
    borderRightColor: colors.borderSoft,
    borderRightWidth: 1,
    flexBasis: 400,
    flexGrow: 0,
    flexShrink: 0,
    width: 400,
  },
  stageColumn: { flex: 1, minWidth: 0 },
  stageScroll: { flex: 1 },
  stageContent: { flexGrow: 1, justifyContent: 'center' },

  composerWrap: {
    borderTopColor: colors.borderSoft,
    borderTopWidth: 1,
    padding: space.small,
  },
  keyPrompt: { ...type.eyebrow, color: colors.accentText, letterSpacing: 0 },

  tabs: {
    flexDirection: 'row',
    gap: space.snug,
    paddingHorizontal: space.medium,
    paddingVertical: space.snug,
  },
  tab: {
    borderRadius: radius.small,
    paddingHorizontal: space.small,
    paddingVertical: space.tight,
  },
  tabOn: { backgroundColor: colors.accentSurface },
  tabText: { ...type.label, color: colors.textFaint },
  tabTextOn: { color: colors.accentText },

  inspectorColumn: {
    borderLeftColor: colors.borderSoft,
    borderLeftWidth: 1,
    flexBasis: 380,
    flexGrow: 0,
    flexShrink: 0,
    minHeight: 0,
    width: 380,
  },
  // Under the board rather than beside it, on a window too narrow for three
  // columns. `flexGrow: 0` because a flexed child of a ScrollView grows to fill
  // it instead of scrolling, which would push the board off the top.
  stageInspector: {
    borderTopColor: colors.borderSoft,
    borderTopWidth: 1,
    flexGrow: 0,
    marginTop: space.medium,
    minHeight: 360,
  },
  waiting: {
    borderTopColor: colors.borderSoft,
    borderTopWidth: 1,
    padding: space.small,
  },

  muted: { ...type.meta, color: colors.textDim },
  rawScroll: { maxHeight: 420, flexGrow: 0 },
  raw: {
    ...type.meta,
    backgroundColor: colors.surfaceWell,
    borderRadius: radius.small,
    color: colors.text,
    fontFamily: 'monospace',
    minHeight: 320,
    padding: space.small,
    ...Platform.select({ web: { outlineStyle: 'none' as never } }),
  },
});
