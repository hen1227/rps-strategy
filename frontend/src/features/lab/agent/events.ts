// What the agent did, in three layers.
//
//  1. **Events** — what the loop emits. No vendor names, no React.
//  2. **Items** — what the rail renders, one per bubble or step.
//  3. **The run** — the live status line and how it ended.
//
// The reducer between them is pure, which is the point: everything the panel
// shows about a run can be tested by feeding it a list of events, with no
// browser, no model and no clock.

import type { SpecChange } from './specDiff';

export type RunId = string;
export type StepId = string;

export type RunStatus = 'thinking' | 'streaming' | 'calling' | 'stopping' | 'done' | 'error';

export type StepStatus =
  /** The model has named it; the arguments are still arriving. */
  | 'pending'
  /** Running now. */
  | 'running'
  | 'ok'
  | 'failed'
  /** The run was stopped before this finished. */
  | 'stopped'
  /** Never ran: bad arguments, or a tool that is not registered any more. */
  | 'rejected';

/** One tool call the page's own agent made, at every stage of its life. */
export interface ToolStep {
  id: StepId;
  runId: RunId;
  turn: number;
  tool: string;
  /** The raw JSON as it streamed, so the expander can show it materialising. */
  argsText: string;
  /** Parsed arguments, or null while streaming and if the JSON never parsed. */
  input: Record<string, unknown> | null;
  status: StepStatus;
  /** The one-line `summary` every Lab tool answers with. */
  summary: string | null;
  /** The whole result, for the expander. Never what gets sent to the model. */
  detail: unknown;
  /** What this call did to the draft, in words. Usually empty: most tools read. */
  changes: SpecChange[];
  startedAtMs: number | null;
  endedAtMs: number | null;
}

/** A call somebody else's agent made, through `document.modelContext`. */
export interface ExternalStep {
  id: StepId;
  transcriptId: number;
  tool: string;
  input: unknown;
  summary: string;
  ok: boolean;
  atMs: number;
}

/**
 * Something the person did with the page's own controls.
 *
 * Not "you pressed the button you pressed": what lands here is the *change*,
 * because that is the part the agent will react to and the part worth having a
 * record of. A press that changed nothing about the mode never becomes one of
 * these — see `watchExternalCalls`.
 */
export interface HumanStep {
  id: StepId;
  transcriptId: number;
  tool: string;
  summary: string;
  changes: SpecChange[];
  ok: boolean;
  atMs: number;
}

export type ChatItem =
  | { kind: 'user'; id: string; runId: RunId | null; text: string; queued: boolean; atMs: number }
  | { kind: 'assistant'; id: string; runId: RunId; text: string; streaming: boolean; atMs: number }
  | { kind: 'step'; id: string; runId: RunId; step: ToolStep }
  | { kind: 'external'; id: string; step: ExternalStep }
  | { kind: 'human'; id: string; step: HumanStep }
  | {
      kind: 'notice';
      id: string;
      runId: RunId | null;
      tone: 'error' | 'info';
      text: string;
      atMs: number;
    };

export type StopReason = 'complete' | 'stopped' | 'max-turns' | 'max-wall' | 'error' | 'stuck';

export interface RunStop {
  reason: StopReason;
  message?: string;
}

export interface AgentRun {
  id: RunId;
  status: RunStatus;
  startedAtMs: number;
  endedAtMs: number | null;
  turn: number;
  /** The live line: "Playing 40 test games…", "Writing…", "Thinking…". */
  statusLine: string;
  stop: RunStop | null;
  usage: { inputTokens: number; outputTokens: number } | null;
}

export type AgentEvent =
  | { type: 'run.started'; runId: RunId; atMs: number }
  | { type: 'turn.started'; runId: RunId; turn: number; toolCount: number }
  | { type: 'text.delta'; runId: RunId; itemId: string; delta: string }
  | { type: 'text.done'; runId: RunId; itemId: string; text: string }
  | { type: 'tool.proposed'; runId: RunId; stepId: StepId; tool: string; turn: number }
  | { type: 'tool.args.delta'; runId: RunId; stepId: StepId; delta: string }
  | {
      type: 'tool.started';
      runId: RunId;
      stepId: StepId;
      input: Record<string, unknown>;
      atMs: number;
    }
  | {
      type: 'tool.settled';
      runId: RunId;
      stepId: StepId;
      ok: boolean;
      summary: string;
      detail: unknown;
      changes: SpecChange[];
      atMs: number;
    }
  | {
      type: 'tool.rejected';
      runId: RunId;
      stepId: StepId;
      why: 'unknown-tool' | 'bad-arguments';
      message: string;
    }
  | { type: 'status'; runId: RunId; line: string }
  | { type: 'usage'; runId: RunId; inputTokens: number; outputTokens: number }
  | { type: 'run.ended'; runId: RunId; stop: RunStop; atMs: number };

export interface AgentChatState {
  items: ChatItem[];
  run: AgentRun | null;
  /** A message typed while a run was in flight, waiting its turn. */
  queued: string | null;
}

export const emptyChat = (): AgentChatState => ({ items: [], run: null, queued: null });

/* ----------------------------------------------------------------- helpers -- */

const replace = (
  items: ChatItem[],
  id: string,
  change: (item: ChatItem) => ChatItem,
): ChatItem[] => {
  const index = items.findIndex((item) => item.id === id);
  if (index === -1) return items;
  const next = items.slice();
  next[index] = change(next[index]!);
  return next;
};

const patchStep = (
  items: ChatItem[],
  stepId: StepId,
  change: (step: ToolStep) => ToolStep,
): ChatItem[] =>
  replace(items, stepId, (item) =>
    item.kind === 'step' ? { ...item, step: change(item.step) } : item,
  );

const TERMINAL: StepStatus[] = ['ok', 'failed', 'rejected', 'stopped'];

/* ----------------------------------------------------------------- reducer -- */

/** Pure. This is the whole of what the rail knows, and the whole of the tests. */
export const applyAgentEvent = (state: AgentChatState, event: AgentEvent): AgentChatState => {
  switch (event.type) {
    case 'run.started':
      return {
        ...state,
        run: {
          id: event.runId,
          status: 'thinking',
          startedAtMs: event.atMs,
          endedAtMs: null,
          turn: 0,
          statusLine: 'Thinking…',
          stop: null,
          usage: null,
        },
      };

    case 'turn.started':
      return state.run
        ? { ...state, run: { ...state.run, turn: event.turn, status: 'thinking' } }
        : state;

    case 'text.delta': {
      const existing = state.items.find(
        (item) => item.kind === 'assistant' && item.id === event.itemId,
      );
      const run = state.run ? { ...state.run, status: 'streaming' as const } : state.run;
      if (!existing) {
        return {
          ...state,
          run,
          items: [
            ...state.items,
            {
              kind: 'assistant',
              id: event.itemId,
              runId: event.runId,
              text: event.delta,
              streaming: true,
              atMs: Date.now(),
            },
          ],
        };
      }
      return {
        ...state,
        run,
        items: replace(state.items, event.itemId, (item) =>
          item.kind === 'assistant' ? { ...item, text: item.text + event.delta } : item,
        ),
      };
    }

    case 'text.done':
      // The item's own text wins over the accumulated deltas. Deltas are for
      // pixels; the completed item is what the conversation is built from.
      return {
        ...state,
        items: replace(state.items, event.itemId, (item) =>
          item.kind === 'assistant' ? { ...item, text: event.text, streaming: false } : item,
        ),
      };

    case 'tool.proposed':
      return {
        ...state,
        items: [
          ...state.items,
          {
            kind: 'step',
            id: event.stepId,
            runId: event.runId,
            step: {
              id: event.stepId,
              runId: event.runId,
              turn: event.turn,
              tool: event.tool,
              argsText: '',
              input: null,
              status: 'pending',
              summary: null,
              detail: null,
              changes: [],
              startedAtMs: null,
              endedAtMs: null,
            },
          },
        ],
      };

    case 'tool.args.delta':
      return {
        ...state,
        items: patchStep(state.items, event.stepId, (step) => ({
          ...step,
          argsText: step.argsText + event.delta,
        })),
      };

    case 'tool.started':
      return {
        ...state,
        run: state.run ? { ...state.run, status: 'calling' } : state.run,
        items: patchStep(state.items, event.stepId, (step) => ({
          ...step,
          status: 'running',
          input: event.input,
          startedAtMs: event.atMs,
        })),
      };

    case 'tool.settled':
      return {
        ...state,
        items: patchStep(state.items, event.stepId, (step) => ({
          ...step,
          status: event.ok ? 'ok' : 'failed',
          summary: event.summary,
          detail: event.detail,
          changes: event.changes,
          endedAtMs: event.atMs,
        })),
      };

    case 'tool.rejected':
      return {
        ...state,
        items: patchStep(state.items, event.stepId, (step) => ({
          ...step,
          status: 'rejected',
          summary: event.message,
          endedAtMs: Date.now(),
        })),
      };

    case 'status':
      return state.run ? { ...state, run: { ...state.run, statusLine: event.line } } : state;

    case 'usage':
      return state.run
        ? {
            ...state,
            run: {
              ...state.run,
              usage: {
                inputTokens: (state.run.usage?.inputTokens ?? 0) + event.inputTokens,
                outputTokens: (state.run.usage?.outputTokens ?? 0) + event.outputTokens,
              },
            },
          }
        : state;

    case 'run.ended': {
      // Anything still in flight when the run ends was cut off, whatever the
      // reason. A step that says "running" forever is the commonest way a
      // stopped run looks broken.
      const items = state.items.map((item) =>
        item.kind === 'step' &&
        item.runId === event.runId &&
        !TERMINAL.includes(item.step.status)
          ? { ...item, step: { ...item.step, status: 'stopped' as const, endedAtMs: event.atMs } }
          : item.kind === 'assistant' && item.runId === event.runId && item.streaming
            ? { ...item, streaming: false }
            : item,
      );
      const failed = event.stop.reason === 'error' || event.stop.reason === 'stuck';
      const withNotice: ChatItem[] =
        event.stop.message && failed
          ? [
              ...items,
              {
                kind: 'notice',
                id: `${event.runId}-stop`,
                runId: event.runId,
                tone: 'error',
                text: event.stop.message,
                atMs: event.atMs,
              },
            ]
          : items;
      return {
        ...state,
        items: withNotice,
        run: state.run
          ? {
              ...state.run,
              status: failed ? 'error' : 'done',
              endedAtMs: event.atMs,
              stop: event.stop,
              statusLine: '',
            }
          : state.run,
      };
    }

    default:
      return state;
  }
};

/** Fold a whole list, for tests and for replaying a run. */
export const applyAgentEvents = (state: AgentChatState, events: AgentEvent[]): AgentChatState =>
  events.reduce(applyAgentEvent, state);
