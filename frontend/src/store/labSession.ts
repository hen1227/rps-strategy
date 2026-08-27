// The RPS Lab's own state: one draft, one sandbox game, and what both hands did.
//
// Its own store rather than a slice of `gameStore`, and that is not tidiness:
// `SessionBridge` in `app/_layout.tsx` sends the browser to `/play` whenever
// `gameStore.gameState` holds a game, so a Lab that put its test game there
// would redirect itself away the moment somebody started one. The analysis board
// keeps its game in local state for the same reason.
//
// Everything the WebMCP tools do goes through here, and so does everything the
// buttons do. One path, so a mode the agent built and a mode a person built are
// the same mode, made the same way — and so that a person's edit is recorded by
// the same wrapper an agent's is, which is the whole of how the agent finds out
// about it.
//
// Three things here exist only so the two hands can reach each other:
// `pendingPrompt` (the agent asking), `pendingProposal` (the agent offering a
// change rather than making it) and `spotlight` (the agent pointing at a square).
// All three are held *as state with a resolver in them*, because the tool call
// on the other end is still waiting while the person decides.

import { create } from 'zustand';

import {
  applyAnalysisMove,
  createAnalysisGame,
  type AnalysisGame,
} from '@/engine/analysisGame';
import { TOTAL_WAR_SPEC } from '@/engine/spec/builtin';
import { modeDefinitionFor } from '@/engine/spec/interpret';
import { simulate, type SimulateReport } from '@/engine/spec/simulate';
import { validateSpec, type SpecReport } from '@/engine/spec/validate';
import { SPEC_VERSION, type RuleSpec } from '@/engine/spec/types';
import type { SpecChange } from '@/features/lab/agent/specDiff';
import type { ModeDefinition, Position } from '@/types/game';

/** One thing somebody did — an agent, a browser agent, or the person here. */
export interface LabToolCall {
  id: number;
  tool: string;
  input: unknown;
  summary: string;
  ok: boolean;
  atMs: number;
  /**
   * Who ran it: `lab-agent` for the chat on this page, `you` for a control on
   * it, and `external` for a browser agent or an extension coming in through
   * `document.modelContext` — which is the default, because that is exactly what
   * a caller who said nothing about itself is.
   *
   * The Lab shows all three, which is the point of recording it — a page whose
   * tools an outside agent is driving should say so rather than look idle, and
   * an agent that is about to suggest something should know the person just
   * moved the pieces. Attribution is by this label rather than by "was a run in
   * flight", because the two genuinely overlap.
   */
  origin: string;
  /**
   * What the call did to the draft, in the words a designer uses.
   *
   * Recorded rather than derived later because the diff needs the draft on
   * either side of the call, and by the time anything reads the transcript the
   * "before" is gone. Usually empty: most tools read.
   */
  changes: SpecChange[];
}

/** What a person answered, or nothing if they never did. */
export interface LabAnswer {
  /** The id of the option they chose, when they chose one. */
  id?: string;
  /** What they typed, when the question invited it. */
  text?: string;
}

/**
 * A question the page is holding up on somebody's behalf.
 *
 * `resolve` is in the state on purpose: the tool call that asked is still
 * awaiting this promise, so the answer has to travel back out through the same
 * object the button presses into.
 */
export interface LabPrompt {
  question: string;
  /** What they may press. Two for a confirmation; more for a real choice. */
  options: { id: string; label: string }[];
  /** Whether they may write something instead of pressing one of the options. */
  allowText: boolean;
  resolve: (answer: LabAnswer | null) => void;
}

/** A change the agent has offered and not made. */
export interface LabProposal {
  /** The fragment, exactly as `lab_patch_spec` would take it. */
  patch: Partial<RuleSpec>;
  /** The draft as it would be, for the preview. Never applied until they say. */
  spec: RuleSpec;
  changes: SpecChange[];
  /** One line from the agent about why. */
  note: string;
  resolve: (answer: { applied: boolean; text?: string }) => void;
}

/**
 * Somewhere the agent is pointing.
 *
 * Not a selection and not a rule: a decoration with a sentence attached, which
 * the board draws as an overlay and the inspector draws as a ring. It changes
 * nothing about the mode, which is why the tool that sets it is read-only.
 */
export interface LabSpotlight {
  squares: Position[];
  /** A piece kind's id, when the agent is talking about a kind. */
  piece: string | null;
  /** A path into the spec, like `win[1]`, when it is talking about a rule. */
  path: string | null;
  note: string;
  atMs: number;
}

export interface LabState {
  /** The mode being designed. Always a whole spec, valid or not. */
  draft: RuleSpec;
  report: SpecReport;
  /** The mode as every board component reads one. */
  mode: ModeDefinition;
  /** The sandbox game, or null when nobody has started one. */
  game: AnalysisGame | null;
  /** Positions before the current one, for undo. */
  history: AnalysisGame[];
  selected: Position | null;
  simulation: SimulateReport | null;
  transcript: LabToolCall[];
  publishedModeId: string | null;
  publishError: string | null;
  /** A question the page is waiting on, asked by a tool that stopped to ask. */
  pendingPrompt: LabPrompt | null;
  /** A change the agent has offered, waiting for a yes. */
  pendingProposal: LabProposal | null;
  /** Where the agent is pointing, or nowhere. */
  spotlight: LabSpotlight | null;
  /**
   * What the person has done since the agent last had a turn.
   *
   * Drained by `labChat` into one note at the top of the next turn. A buffer
   * rather than a push because waking the model on a click would spend money
   * every time somebody nudged a piece.
   */
  pendingActivity: LabToolCall[];

  setDraft: (spec: RuleSpec) => SpecReport;
  patchDraft: (patch: Partial<RuleSpec>) => SpecReport;
  newGame: (options?: { rows?: string[] }) => AnalysisGame | null;
  endGame: () => void;
  play: (from: Position, to: Position) => boolean;
  undo: () => boolean;
  select: (position: Position | null) => void;
  runSimulation: (options?: { games?: number; strength?: number; seed?: number }) => SimulateReport;
  record: (
    entry: Omit<LabToolCall, 'id' | 'atMs' | 'origin' | 'changes'> & {
      origin?: string;
      changes?: SpecChange[];
    },
  ) => void;
  clearTranscript: () => void;
  takeActivity: () => LabToolCall[];
  ask: (prompt: Omit<LabPrompt, 'resolve'>, signal?: AbortSignal) => Promise<LabAnswer | null>;
  answerPrompt: (answer: LabAnswer | null) => void;
  askToConfirm: (message: string, signal?: AbortSignal) => Promise<boolean>;
  answerConfirm: (agreed: boolean) => void;
  propose: (
    proposal: Omit<LabProposal, 'resolve'>,
    signal?: AbortSignal,
  ) => Promise<{ applied: boolean; text?: string }>;
  answerProposal: (applied: boolean, text?: string) => void;
  setSpotlight: (spotlight: Omit<LabSpotlight, 'atMs'> | null) => void;
  setPublished: (modeId: string | null, error?: string | null) => void;
}

/**
 * Where a new Lab session starts.
 *
 * Total War with its name taken off. Starting from a game that works — rather
 * than from an empty document — is what makes the first edit a change to
 * something playable instead of a blank page, and it is what the agent reads to
 * see the shape of a spec before writing one.
 */
export const STARTING_DRAFT: RuleSpec = {
  ...TOTAL_WAR_SPEC,
  spec: SPEC_VERSION,
  name: 'Untitled mode',
  shortCode: 'NEW',
  description: 'A new game, starting from Total War.',
  objective: 'Annihilate the enemy or control most territory when the board is filled.',
};

/** The one place a draft becomes something the board can draw. */
const modeFor = (spec: RuleSpec): ModeDefinition => modeDefinitionFor(spec, 'lab-draft');

let nextCallId = 1;

/** How many of the person's actions are worth carrying into the next turn. */
const ACTIVITY_LIMIT = 20;

export const useLabStore = create<LabState>((set, get) => ({
  draft: STARTING_DRAFT,
  report: validateSpec(STARTING_DRAFT),
  mode: modeFor(STARTING_DRAFT),
  game: null,
  history: [],
  selected: null,
  simulation: null,
  transcript: [],
  publishedModeId: null,
  publishError: null,
  pendingPrompt: null,
  pendingProposal: null,
  spotlight: null,
  pendingActivity: [],

  setDraft: (spec) => {
    const report = validateSpec(spec);
    set({
      draft: spec,
      report,
      mode: modeFor(spec),
      // The rules changed, so the game played under the old ones is not a
      // position in this mode any more. Ending it is honest; keeping it would
      // show a board whose moves no longer follow from what is on screen.
      game: null,
      history: [],
      selected: null,
      simulation: null,
      publishedModeId: null,
      // The board it was pointing at is gone with the game, and a ring left over
      // a square that now holds something else is worse than no ring.
      spotlight: null,
    });
    return report;
  },

  patchDraft: (patch) => get().setDraft({ ...get().draft, ...patch }),

  newGame: (options) => {
    const { draft, report } = get();
    // A spec with errors has no legal moves to offer, so starting a game in it
    // would be a board that looks playable and is not.
    if (report.errors.length > 0) return null;
    const mode = modeFor(draft);
    const game = createAnalysisGame(
      mode,
      options?.rows ? { rows: options.rows } : draft.startingPosition,
    );
    set({ mode, game, history: [], selected: null });
    return game;
  },

  endGame: () => set({ game: null, history: [], selected: null }),

  play: (from, to) => {
    const { game } = get();
    if (!game) return false;
    const played = applyAnalysisMove(game, from, to);
    if (!played) return false;
    set((state) => ({
      game: played.game,
      history: [...state.history, game],
      selected: null,
    }));
    return true;
  },

  undo: () => {
    const { history } = get();
    const previous = history.at(-1);
    if (!previous) return false;
    set({ game: previous, history: history.slice(0, -1), selected: null });
    return true;
  },

  select: (position) => set({ selected: position }),

  runSimulation: (options = {}) => {
    const report = simulate(get().draft, {
      games: options.games ?? 40,
      strength: options.strength ?? 0.6,
      seed: options.seed ?? 1,
    });
    set({ simulation: report });
    return report;
  },

  record: (entry) =>
    set((state) => {
      // Coalesced, not spread over a default. A caller who said nothing about
      // itself passes `origin: options?.origin` — the *key is present* and the
      // value is `undefined` — so `{ origin: 'external', ...entry }` writes the
      // undefined straight over the default. That left every outside agent's
      // call unattributed, and `watchExternalCalls` matches on the exact string,
      // so their work never reached the rail at all: the one failure on this
      // path that is invisible from the page.
      const call: LabToolCall = {
        ...entry,
        origin: entry.origin ?? 'external',
        changes: entry.changes ?? [],
        id: nextCallId++,
        atMs: Date.now(),
      };
      return {
        // Bounded: a long session is a long transcript, and the panel only ever
        // shows the recent end of it.
        transcript: [...state.transcript, call].slice(-100),
        // Only the person's own work waits to be told to the agent. Its own
        // calls it already remembers, and an outside agent's are not this
        // conversation's business to narrate.
        pendingActivity:
          call.origin === 'you'
            ? [...state.pendingActivity, call].slice(-ACTIVITY_LIMIT)
            : state.pendingActivity,
      };
    }),

  clearTranscript: () => set({ transcript: [] }),

  takeActivity: () => {
    const activity = get().pendingActivity;
    if (activity.length > 0) set({ pendingActivity: [] });
    return activity;
  },

  /**
   * Stop and ask.
   *
   * The promise resolves when somebody presses a button, which is the whole
   * point: the tool call is still waiting when they do.
   *
   * An abandoned question has to answer itself. The caller may be an agent run
   * that has just been stopped, and a promise nobody will ever resolve is a run
   * that never ends and a Stop button that looks broken. The abandoned answer is
   * `null` — *no answer*, which is a different thing from any of the options and
   * is what an agent should read as "they never said".
   */
  ask: (prompt, signal) =>
    new Promise<LabAnswer | null>((resolve) => {
      if (signal?.aborted) {
        resolve(null);
        return;
      }
      let settled = false;
      const answer = (value: LabAnswer | null) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      signal?.addEventListener('abort', () => {
        if (get().pendingPrompt?.resolve === answer) set({ pendingPrompt: null });
        answer(null);
      });
      set({ pendingPrompt: { ...prompt, resolve: answer } });
    }),

  answerPrompt: (answer) => {
    const pending = get().pendingPrompt;
    set({ pendingPrompt: null });
    pending?.resolve(answer);
  },

  /**
   * The yes-or-no case, which is what publishing needs.
   *
   * One caller of `ask` rather than its own mechanism, so there is one dialog
   * and one abort rule. Declining is the safe reading of an abandoned
   * confirmation, and it is why this collapses `null` to `false` where a general
   * question keeps the distinction.
   */
  askToConfirm: async (message, signal) => {
    const answer = await get().ask(
      {
        question: message,
        options: [
          { id: 'no', label: 'NO' },
          { id: 'yes', label: 'YES, PUBLISH' },
        ],
        allowText: false,
      },
      signal,
    );
    return answer?.id === 'yes';
  },

  answerConfirm: (agreed) => get().answerPrompt({ id: agreed ? 'yes' : 'no' }),

  /**
   * Offer a change instead of making one.
   *
   * Same abandonment rule as `ask`, and the same reason: a run that was stopped
   * must not leave a promise nobody will resolve. An abandoned offer was not
   * applied, which is the honest answer and the safe one.
   */
  propose: (proposal, signal) =>
    new Promise<{ applied: boolean; text?: string }>((resolve) => {
      if (signal?.aborted) {
        resolve({ applied: false });
        return;
      }
      let settled = false;
      const answer = (value: { applied: boolean; text?: string }) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      signal?.addEventListener('abort', () => {
        if (get().pendingProposal?.resolve === answer) set({ pendingProposal: null });
        answer({ applied: false });
      });
      set({ pendingProposal: { ...proposal, resolve: answer } });
    }),

  answerProposal: (applied, text) => {
    const pending = get().pendingProposal;
    set({ pendingProposal: null });
    if (!pending) return;
    // Applied through `setDraft`, the same door `lab_patch_spec` goes through,
    // so an accepted proposal and an ordinary patch leave the draft in exactly
    // the same state — including ending the test game.
    if (applied) get().setDraft(pending.spec);
    pending.resolve({ applied, ...(text ? { text } : {}) });
  },

  setSpotlight: (spotlight) =>
    set({ spotlight: spotlight ? { ...spotlight, atMs: Date.now() } : null }),

  setPublished: (modeId, error = null) =>
    set({ publishedModeId: modeId, publishError: error }),
}));
