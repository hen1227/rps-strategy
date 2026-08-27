// The Lab's conversation, and the run it is having.
//
// Three things live here and one deliberately does not:
//
//  * **items** — what the rail draws, produced by folding the loop's events
//    through the pure reducer in `features/lab/agent/events.ts`.
//  * **the run** — the live status line, and how it ended.
//  * **the transport** — whether this server holds a key, or the visitor does.
//
// The *conversation* — the items the model sends and receives — is a module
// reference rather than state. It churns on every completed item, nothing draws
// it, and putting it in a store would re-render the page for each one. Same for
// the `AbortController`, which is not serialisable.

import { create } from 'zustand';

import {
  applyAgentEvent,
  emptyChat,
  type AgentChatState,
  type ChatItem,
} from '@/features/lab/agent/events';
import { runAgent } from '@/features/lab/agent/loop';
import { SYSTEM_PROMPT } from '@/features/lab/agent/prompt';
import { DEFAULT_MODEL, directTransport, proxyTransport } from '@/features/lab/agent/transport';
import type { AgentTransport, ResponseItem } from '@/features/lab/agent/wire';
import { callTool, registeredTools } from '@/webmcp/modelContext';
import { deviceStorage } from '@/store/deviceStorage';
import { useLabStore, type LabToolCall } from '@/store/labSession';
import type { RequestIdentity } from '@/store/api/identity';

const KEY_STORAGE = 'rps.lab.openaiKey';
const MODEL_STORAGE = 'rps.lab.openaiModel';

/** Where the agent's answers come from, and whether there is one at all. */
export type AgentSource =
  /** Not asked yet. */
  | { kind: 'unknown' }
  /** This server holds a key. */
  | { kind: 'proxy'; model: string }
  /** The visitor holds one. */
  | { kind: 'direct'; model: string }
  /** Neither, so the chat asks for a key. */
  | { kind: 'none' };

interface LabChatState extends AgentChatState {
  source: AgentSource;
  /** The key the visitor pasted, if any. Never sent anywhere but OpenAI. */
  apiKey: string | null;
  identity: RequestIdentity | null;

  setIdentity: (identity: RequestIdentity) => void;
  discoverSource: () => Promise<void>;
  setApiKey: (key: string, model?: string, remember?: boolean) => void;
  forgetApiKey: () => void;

  send: (text: string) => void;
  stop: () => void;
  reset: () => void;
  noteExternal: (entry: LabToolCall) => void;
  noteHuman: (entry: LabToolCall) => void;
}

/* --------------------------------------------------- what does not re-render -- */

let conversation: ResponseItem[] = [];
let controller: AbortController | null = null;
let itemCounter = 0;

const nextId = (prefix: string) => `${prefix}-${(itemCounter += 1)}`;

const storage = () => deviceStorage();

const rememberedKey = () => storage()?.getItem(KEY_STORAGE) ?? null;
const rememberedModel = () => storage()?.getItem(MODEL_STORAGE) || DEFAULT_MODEL;

/* ------------------------------------------------------------------- store -- */

export const useLabChat = create<LabChatState>((set, get) => ({
  ...emptyChat(),
  source: { kind: 'unknown' },
  apiKey: null,
  identity: null,

  setIdentity: (identity) => set({ identity }),

  /**
   * Ask the server whether it can run the agent, and fall back to a key of the
   * visitor's own.
   *
   * A server with no key is the ordinary case for a checkout, so this is not an
   * error path: it is how the Lab decides which of two working modes it is in.
   */
  discoverSource: async () => {
    const stored = rememberedKey();
    if (stored) set({ apiKey: stored });
    try {
      const { getAgentStatus } = await import('@/store/api/labAgent');
      const status = await getAgentStatus();
      if (status.configured) {
        set({ source: { kind: 'proxy', model: status.model } });
        return;
      }
    } catch {
      // No server, or an old one. A pasted key still works, and saying so is
      // more useful than an error about a route that is allowed to be absent.
    }
    set({
      source: stored ? { kind: 'direct', model: rememberedModel() } : { kind: 'none' },
    });
  },

  setApiKey: (key, model = DEFAULT_MODEL, remember = false) => {
    const trimmed = key.trim();
    if (!trimmed) return;
    if (remember) {
      storage()?.setItem(KEY_STORAGE, trimmed);
      storage()?.setItem(MODEL_STORAGE, model);
    }
    set({ apiKey: trimmed, source: { kind: 'direct', model } });
  },

  forgetApiKey: () => {
    storage()?.removeItem(KEY_STORAGE);
    set({ apiKey: null, source: { kind: 'none' } });
  },

  /**
   * Say something.
   *
   * A message sent while a run is in flight is *queued* rather than interleaved.
   * The Lab's tools are stateful — half of one run and half of another over one
   * shared draft is a draft neither of them understands — so the second message
   * waits for the first to finish and then continues the same conversation.
   */
  send: (text) => {
    const message = text.trim();
    if (!message) return;
    const state = get();

    if (state.run && state.run.endedAtMs === null) {
      set({
        queued: message,
        items: [
          ...state.items.filter((item) => !(item.kind === 'user' && item.queued)),
          {
            kind: 'user',
            id: nextId('user'),
            runId: null,
            text: message,
            queued: true,
            atMs: Date.now(),
          },
        ],
      });
      return;
    }

    const transport = transportFor(state);
    if (!transport) {
      set({ source: { kind: 'none' } });
      return;
    }

    set({
      queued: null,
      items: [
        ...state.items.filter((item) => !(item.kind === 'user' && item.queued)),
        { kind: 'user', id: nextId('user'), runId: null, text: message, queued: false, atMs: Date.now() },
      ],
    });
    const note = activityNote(useLabStore.getState().takeActivity());
    if (note) conversation.push({ type: 'message', role: 'user', content: note });
    conversation.push({ type: 'message', role: 'user', content: message });

    controller = new AbortController();
    const signal = controller.signal;

    void (async () => {
      try {
        for await (const event of runAgent(conversation, {
          transport,
          instructions: SYSTEM_PROMPT,
          signal,
          listTools: registeredTools,
          callTool,
          readDraft: () => useLabStore.getState().draft,
        })) {
          set((current) => applyAgentEvent(current, event));
        }
      } finally {
        controller = null;
        const waiting = get().queued;
        if (waiting && !signal.aborted) {
          set({ queued: null });
          get().send(waiting);
        }
      }
    })();
  },

  stop: () => {
    controller?.abort();
    controller = null;
    set({ queued: null });
  },

  reset: () => {
    controller?.abort();
    controller = null;
    conversation = [];
    set({ ...emptyChat() });
  },

  /**
   * A call somebody else's agent made.
   *
   * The page's tools are public, so Chrome's agent or an extension can drive
   * them while this chat sits idle — and a page being driven by an agent should
   * say so rather than look asleep. It is attributed by the `origin` the caller
   * gave, not by whether a run happened to be in flight, because the two overlap.
   */
  noteExternal: (entry) =>
    set((state) => ({
      items: [
        ...state.items,
        {
          kind: 'external',
          id: `external-${entry.id}`,
          step: {
            id: `external-${entry.id}`,
            transcriptId: entry.id,
            tool: entry.tool,
            input: entry.input,
            summary: entry.summary,
            ok: entry.ok,
            atMs: entry.atMs,
          },
        } satisfies ChatItem,
      ],
    })),

  /**
   * Something the person just did with their own hands.
   *
   * What goes in the rail is the *change*, not the press: nobody needs telling
   * in their own conversation that they pressed the button they pressed. But the
   * agent is about to be told about it, and a person should be able to see what
   * the agent is reacting to — so an edit that moved the mode gets a line and an
   * edit that moved nothing does not.
   */
  noteHuman: (entry) =>
    set((state) => ({
      items: [
        ...state.items,
        {
          kind: 'human',
          id: `human-${entry.id}`,
          step: {
            id: `human-${entry.id}`,
            transcriptId: entry.id,
            tool: entry.tool,
            summary: entry.summary,
            changes: entry.changes,
            ok: entry.ok,
            atMs: entry.atMs,
          },
        } satisfies ChatItem,
      ],
    })),
}));

/**
 * The person's work since the agent last ran, as one line for the model.
 *
 * One note rather than one per action, and prepended to the turn rather than
 * pushed at the moment it happens: waking the model every time somebody nudges a
 * piece would spend money on every click, and half a run's worth of edits
 * arriving mid-turn is a draft the model does not understand.
 */
const activityNote = (activity: LabToolCall[]): string | null => {
  const done = activity
    .map((entry) => entry.changes.map((change) => change.label).join(', '))
    .filter(Boolean);
  if (done.length === 0) return null;
  return (
    'The person has been working on the mode themselves since your last turn: ' +
    `${done.join('; ')}. Look before you assume the mode is the one you left.`
  );
};

const transportFor = (state: LabChatState): AgentTransport | null => {
  if (state.source.kind === 'proxy' && state.identity) return proxyTransport(state.identity);
  if (state.apiKey) {
    return directTransport({
      apiKey: state.apiKey,
      model: state.source.kind === 'direct' ? state.source.model : rememberedModel(),
    });
  }
  return null;
};

/**
 * Watch the transcript for calls this chat did not make.
 *
 * Subscribed once, at module scope, because the transcript is the single record
 * of every tool call however it arrived — which is the only reason an outside
 * agent's work can appear here at all.
 */
let watching = false;
export const watchExternalCalls = () => {
  if (watching) return;
  watching = true;
  // By id, not by length: the transcript is capped at a hundred entries, so once
  // it is full its length stops changing while calls keep arriving.
  let lastSeen = useLabStore.getState().transcript.at(-1)?.id ?? 0;
  useLabStore.subscribe((next) => {
    const fresh = next.transcript.filter((entry) => entry.id > lastSeen);
    if (fresh.length === 0) return;
    lastSeen = fresh[fresh.length - 1]!.id;
    for (const entry of fresh) {
      // The chat's own calls are already drawn as steps of their run, so they are
      // the one origin with nothing to add here. The other two both do: an
      // outside agent's work, because a page being driven from outside should say
      // so rather than look idle, and the person's own, because it is what the
      // agent will be told about at the start of its next turn — and a person
      // should be able to see what the agent is reacting to.
      if (entry.origin === 'external') useLabChat.getState().noteExternal(entry);
      // The press itself is not news; what it did to the mode is. An edit that
      // changed nothing — a playtest, a look at the board — stays out of the rail.
      else if (entry.origin === 'you' && entry.changes.length > 0) {
        useLabChat.getState().noteHuman(entry);
      }
    }
  });
};
