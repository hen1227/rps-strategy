// The agent loop: ask the model, run what it asks for, ask again.
//
// It owns the conversation and the bounds, and it owns nothing else. The tools
// come from `document.modelContext` — the same door a browser agent uses — and
// the bytes come from a transport it cannot see inside. That is what keeps this
// file testable with no network, no browser and no model, and it is why every
// interesting failure below has a test rather than a comment promising it works.
//
// Two decisions are load-bearing and worth stating outright:
//
//  * **Tools are re-read every turn, and re-resolved before every call.** The
//    Lab's surface changes with the page — there is no `lab_play_move` until
//    there is a game — and `lab_patch_spec` ends the test game, so a tool can
//    disappear *between two calls the model asked for in one breath*.
//  * **A refusal is a result, not a crash.** Bad JSON, a tool that is gone, a
//    tool that threw, a person declining to publish: all of them come back to
//    the model as an answer it can act on. A run that dies on the first
//    imperfect argument is a demo that dies on stage.

import { UnknownToolError, type CallOptions, type ToolDescriptor, type ToolResult } from '@/webmcp/modelContext';
import type { RuleSpec } from '@/engine/spec/types';

import { describeSpecChange, type SpecChange } from './specDiff';
import {
  functionCallOutput,
  isFunctionCall,
  messageText,
  toolSchemas,
  type AgentTransport,
  type ResponseItem,
} from './wire';
import type { AgentEvent, RunStop } from './events';

export interface RunOptions {
  transport: AgentTransport;
  instructions: string;
  signal: AbortSignal;
  listTools: () => ToolDescriptor[];
  callTool: (
    name: string,
    input: Record<string, unknown>,
    options?: CallOptions,
  ) => Promise<ToolResult>;
  /** The draft, read either side of a call so a change can be described. */
  readDraft?: () => RuleSpec;
  maxTurns?: number;
  maxWallMs?: number;
  /** What one tool result may cost the context. */
  maxOutputBytes?: number;
  now?: () => number;
  newId?: (prefix: string) => string;
}

export const DEFAULTS = {
  maxTurns: 12,
  maxWallMs: 300_000,
  maxOutputBytes: 16_384,
  /** Past this, the oldest tool results are elided rather than resent. */
  maxConversationBytes: 150_000,
  /** Consecutive unparseable argument blobs before we call it stuck. */
  badArgumentLimit: 3,
} as const;

let counter = 0;
const defaultId = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${(counter += 1)}`;

/** Cut a tool result down to what it is worth spending context on. */
const clamp = (value: string, limit: number) =>
  value.length <= limit
    ? value
    : `${value.slice(0, limit)}\n…(${value.length - limit} more characters, not shown)`;

const errorOutput = (error: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ error, ...extra });

/**
 * Keep the conversation from growing without limit.
 *
 * Oldest tool results go first, and only tool results go at all: the newest
 * board is the one the model is reasoning about, and its own messages are how
 * it remembers what it decided.
 */
const trim = (conversation: ResponseItem[], limit: number) => {
  let size = JSON.stringify(conversation).length;
  if (size <= limit) return;
  for (const item of conversation) {
    if (size <= limit) return;
    if (item.type !== 'function_call_output') continue;
    const output = item.output;
    if (typeof output !== 'string' || output === '"(elided)"') continue;
    size -= output.length;
    item.output = '"(elided)"';
  }
};

/**
 * Run one turn-taking conversation to a stopping point.
 *
 * `conversation` is mutated in place and belongs to the caller, so a second
 * message continues where the first left off rather than starting over.
 */
export async function* runAgent(
  conversation: ResponseItem[],
  options: RunOptions,
): AsyncGenerator<AgentEvent> {
  const {
    transport,
    instructions,
    signal,
    listTools,
    callTool,
    readDraft,
    maxTurns = DEFAULTS.maxTurns,
    maxWallMs = DEFAULTS.maxWallMs,
    maxOutputBytes = DEFAULTS.maxOutputBytes,
    now = Date.now,
    newId = defaultId,
  } = options;

  const runId = newId('run');
  const deadline = now() + maxWallMs;
  let badArguments = 0;

  yield { type: 'run.started', runId, atMs: now() };

  const ended = (stop: RunStop): AgentEvent => ({ type: 'run.ended', runId, stop, atMs: now() });

  try {
    for (let turn = 1; turn <= maxTurns; turn += 1) {
      if (signal.aborted) return yield ended({ reason: 'stopped' });
      if (now() > deadline) return yield ended({ reason: 'max-wall' });

      // Re-read, every turn. Not a cache: a statement of what the page can do
      // right now, which is a different list than it was a moment ago.
      const tools = toolSchemas(listTools());
      yield { type: 'turn.started', runId, turn, toolCount: tools.length };
      yield { type: 'status', runId, line: 'Thinking…' };

      const proposed: { stepId: string; call: ReturnType<typeof asCall> }[] = [];
      const announced = new Set<string>();

      for await (const event of transport.stream({ instructions, input: conversation, tools }, signal)) {
        switch (event.type) {
          case 'text.delta':
            yield { type: 'text.delta', runId, itemId: event.itemId, delta: event.delta };
            break;
          case 'args.delta':
            yield { type: 'tool.args.delta', runId, stepId: event.itemId, delta: event.delta };
            break;
          case 'item.added':
            if (event.item.type === 'function_call') {
              const stepId = String(event.item.id ?? event.item.call_id ?? newId('step'));
              announced.add(stepId);
              yield {
                type: 'tool.proposed',
                runId,
                stepId,
                tool: String(event.item.name ?? 'a tool'),
                turn,
              };
            }
            break;
          case 'item.done': {
            // Verbatim, whatever it is. Reasoning items have to make the round
            // trip or the model forgets why it called what it just called.
            conversation.push(event.item);
            if (event.item.type === 'message') {
              yield {
                type: 'text.done',
                runId,
                itemId: String(event.item.id ?? ''),
                text: messageText(event.item),
              };
            }
            if (isFunctionCall(event.item)) {
              const stepId = String(event.item.id ?? event.item.call_id);
              // A server that only sends `done` still gets a step.
              if (!announced.has(stepId)) {
                yield { type: 'tool.proposed', runId, stepId, tool: event.item.name, turn };
              }
              proposed.push({ stepId, call: asCall(event.item) });
            }
            break;
          }
          case 'usage':
            yield {
              type: 'usage',
              runId,
              inputTokens: event.inputTokens,
              outputTokens: event.outputTokens,
            };
            break;
          case 'failed':
            throw new Error(event.message);
        }
      }

      // Nothing to run: the model answered in prose, which is the end of it.
      if (proposed.length === 0) return yield ended({ reason: 'complete' });

      // Sequential, never in parallel. Every one of these mutates one shared
      // draft, and `lab_patch_spec` ends the test game the next call wanted.
      for (const { stepId, call } of proposed) {
        if (signal.aborted) return yield ended({ reason: 'stopped' });

        let input: Record<string, unknown>;
        try {
          input = call.arguments.trim() === '' ? {} : JSON.parse(call.arguments);
        } catch (error) {
          badArguments += 1;
          const message = error instanceof Error ? error.message : String(error);
          yield { type: 'tool.rejected', runId, stepId, why: 'bad-arguments', message };
          conversation.push(
            functionCallOutput(
              call.callId,
              errorOutput('the arguments were not valid JSON', {
                detail: message,
                received: call.arguments.slice(0, 200),
              }),
            ),
          );
          if (badArguments >= DEFAULTS.badArgumentLimit) {
            return yield ended({
              reason: 'stuck',
              message: 'The model kept sending arguments that were not valid JSON.',
            });
          }
          continue;
        }

        // Resolved now, not from the turn's snapshot: the call before this one
        // may have taken this tool away.
        const available = listTools().map((tool) => tool.name);
        if (!available.includes(call.name)) {
          yield {
            type: 'tool.rejected',
            runId,
            stepId,
            why: 'unknown-tool',
            message: `${call.name} is not available right now`,
          };
          conversation.push(
            functionCallOutput(
              call.callId,
              errorOutput(`${call.name} is not available right now`, { available }),
            ),
          );
          continue;
        }

        badArguments = 0;
        yield { type: 'tool.started', runId, stepId, input, atMs: now() };
        yield { type: 'status', runId, line: describeWork(call.name, input) };

        const before = readDraft?.();
        let outcome: ToolResult;
        let ok = true;
        try {
          outcome = await callTool(call.name, input, { signal, origin: 'lab-agent' });
          ok = !outcome.isError;
        } catch (error) {
          if (signal.aborted) return yield ended({ reason: 'stopped' });
          ok = false;
          outcome = {
            content: [
              {
                type: 'text',
                text:
                  error instanceof UnknownToolError
                    ? `${error.message}. Available: ${error.available.join(', ')}`
                    : error instanceof Error
                      ? error.message
                      : String(error),
              },
            ],
          };
        }

        const summary = outcome.content[0]?.text ?? '(no answer)';
        const changes: SpecChange[] =
          before && readDraft ? describeSpecChange(before, readDraft()) : [];

        yield {
          type: 'tool.settled',
          runId,
          stepId,
          ok,
          summary,
          detail: outcome.structuredContent ?? summary,
          changes,
          atMs: now(),
        };

        const body =
          outcome.structuredContent === undefined
            ? summary
            : JSON.stringify(outcome.structuredContent);
        conversation.push(
          functionCallOutput(call.callId, clamp(ok ? body : errorOutput(summary), maxOutputBytes)),
        );
      }

      trim(conversation, DEFAULTS.maxConversationBytes);
    }

    return yield ended({ reason: 'max-turns' });
  } catch (error) {
    if (signal.aborted) return yield ended({ reason: 'stopped' });
    return yield ended({
      reason: 'error',
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

const asCall = (item: { call_id: string; name: string; arguments: string }) => ({
  callId: item.call_id,
  name: item.name,
  arguments: typeof item.arguments === 'string' ? item.arguments : '',
});

/** The live status line, in the words of what is happening rather than the API. */
export const describeWork = (tool: string, input: Record<string, unknown>): string => {
  switch (tool) {
    case 'lab_describe_language':
      return 'Reading the rule format…';
    case 'lab_patch_spec':
    case 'lab_set_spec':
      return 'Editing the rules…';
    case 'lab_set_starting_position':
      return 'Drawing the opening board…';
    case 'lab_validate':
      return 'Checking the rules…';
    case 'lab_simulate': {
      const games = typeof input.games === 'number' ? input.games : 40;
      return `Playing ${games} test games…`;
    }
    case 'lab_new_test_game':
      return 'Starting a test game…';
    case 'lab_play_move':
      return 'Trying a move…';
    case 'lab_legal_moves':
    case 'lab_get_position':
      return 'Looking at the board…';
    case 'lab_search_parts':
    case 'lab_get_part':
      return 'Looking for something to reuse…';
    case 'lab_save_draft':
      return 'Saving…';
    case 'lab_recent_activity':
      return 'Catching up…';
    case 'lab_highlight':
      return 'Pointing at the board…';
    case 'lab_ask_user':
    case 'lab_propose_change':
    case 'lab_publish_mode':
    case 'lab_publish_part':
      return 'Waiting for you…';
    default:
      return 'Working…';
  }
};
