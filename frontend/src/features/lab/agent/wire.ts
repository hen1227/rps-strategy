// The shape of the conversation on the wire, and the only file that knows it.
//
// Everything above this speaks `UpstreamEvent` and `ResponseItem`, so the choice
// of API lives here and nowhere else. That matters more than tidiness: the two
// transports — this browser talking to OpenAI directly, and this browser talking
// to our own relay — carry *identical* bytes, because the relay copies SSE lines
// without understanding them. One parser, one set of tests, two ways in.
//
// The API is Responses (`POST /v1/responses`, `stream: true`). The reason is the
// tool loop: the model returns items, and the client's whole job is to append
// each completed item verbatim and add one `function_call_output` per call.
// Chat Completions makes the client reassemble the assistant message out of
// deltas instead, and a reassembly bug there is a 400 you only find on turn two.

import type { ToolDescriptor } from '@/webmcp/modelContext';

/**
 * One item of the conversation.
 *
 * Deliberately opaque. We build exactly one kind (`function_call_output`) and
 * copy every other kind straight back from the model — including reasoning
 * items, which have to make the round trip or the model forgets why it called
 * the tool it just called.
 */
export type ResponseItem = Record<string, unknown> & { type?: string };

export interface FunctionCallItem extends ResponseItem {
  type: 'function_call';
  call_id: string;
  name: string;
  arguments: string;
}

export interface FunctionTool {
  type: 'function';
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  strict: boolean;
}

const EMPTY_SCHEMA = { type: 'object', properties: {}, additionalProperties: false };

/**
 * The page's tools, as the model's function declarations.
 *
 * `strict: false`, and it is not laziness. Strict function calling additionally
 * demands that every property appear in `required`, and several of these tools
 * have genuinely optional arguments — `lab_simulate` takes games, strength and
 * seed or none of them. `lab_patch_spec.patch` is a bare object by design, since
 * it accepts any fragment of the rule format, and strict forbids that outright.
 * Making the schemas strict-compatible would mean rewriting the tool surface to
 * suit the transport, which is backwards.
 */
export const toolSchemas = (tools: ToolDescriptor[]): FunctionTool[] =>
  tools.map((tool) => ({
    type: 'function',
    name: tool.name,
    description: tool.description,
    parameters: (tool.inputSchema as Record<string, unknown> | undefined) ?? EMPTY_SCHEMA,
    strict: false,
  }));

/** The one item kind we build ourselves. */
export const functionCallOutput = (callId: string, output: string): ResponseItem => ({
  type: 'function_call_output',
  call_id: callId,
  output,
});

export const isFunctionCall = (item: ResponseItem): item is FunctionCallItem =>
  item?.type === 'function_call' && typeof item.call_id === 'string';

/** The prose out of a completed message item. */
export const messageText = (item: ResponseItem): string => {
  const parts = Array.isArray(item.content) ? item.content : [];
  return parts
    .map((part) => {
      const value = (part ?? {}) as Record<string, unknown>;
      return typeof value.text === 'string' ? value.text : '';
    })
    .join('');
};

/* --------------------------------------------------------------- transport -- */

export interface AgentRequest {
  instructions: string;
  input: ResponseItem[];
  tools: FunctionTool[];
}

/**
 * Where the bytes come from.
 *
 * Two implementations — our relay, and this browser talking to OpenAI with a key
 * the user pasted — and the loop cannot tell them apart, because the relay
 * copies frames rather than interpreting them.
 */
export interface AgentTransport {
  readonly kind: 'proxy' | 'direct';
  stream(request: AgentRequest, signal: AbortSignal): AsyncIterable<UpstreamEvent>;
}

/* ------------------------------------------------------------------ events -- */

/** What the loop understands. Nothing above this file names a vendor. */
export type UpstreamEvent =
  | { type: 'text.delta'; itemId: string; delta: string }
  | { type: 'args.delta'; itemId: string; delta: string }
  /** A tool call has been named; its arguments are still streaming. */
  | { type: 'item.added'; item: ResponseItem }
  | { type: 'item.done'; item: ResponseItem }
  | { type: 'usage'; inputTokens: number; outputTokens: number }
  | { type: 'failed'; message: string };

const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const count = (value: unknown): number => (typeof value === 'number' ? value : 0);

/**
 * One SSE frame, as an `UpstreamEvent` or nothing.
 *
 * Unknown events are dropped rather than treated as errors: this API grows new
 * ones, and a page that fell over when it met one would break on a Tuesday for
 * no reason. The events that matter are few, and `response.output_item.done` is
 * the authoritative one — deltas are for pixels.
 */
export const parseUpstreamEvent = (name: string, data: unknown): UpstreamEvent | null => {
  const payload = (data ?? {}) as Record<string, unknown>;
  switch (name) {
    case 'response.output_text.delta':
      return { type: 'text.delta', itemId: text(payload.item_id), delta: text(payload.delta) };
    case 'response.function_call_arguments.delta':
      return { type: 'args.delta', itemId: text(payload.item_id), delta: text(payload.delta) };
    case 'response.output_item.added':
      return payload.item ? { type: 'item.added', item: payload.item as ResponseItem } : null;
    case 'response.output_item.done':
      return payload.item ? { type: 'item.done', item: payload.item as ResponseItem } : null;
    case 'response.completed': {
      const usage = ((payload.response as Record<string, unknown>)?.usage ?? {}) as Record<
        string,
        unknown
      >;
      return {
        type: 'usage',
        inputTokens: count(usage.input_tokens),
        outputTokens: count(usage.output_tokens),
      };
    }
    case 'response.failed':
    case 'response.incomplete':
    case 'error':
    case 'rps.error': {
      const error = (payload.error ?? payload.response ?? payload) as Record<string, unknown>;
      const nested = (error?.error ?? error) as Record<string, unknown>;
      return {
        type: 'failed',
        message: text(nested?.message) || text(payload.message) || 'the model stopped unexpectedly',
      };
    }
    default:
      return null;
  }
};

/* --------------------------------------------------------------------- SSE -- */

export interface SseFrame {
  event: string;
  data: unknown;
}

/**
 * Server-sent frames from a stream of bytes.
 *
 * Takes an async iterable rather than a `ReadableStream` so the tests can hand
 * it three strings and no browser. Chunk boundaries fall wherever the network
 * put them, so the buffer is what does the work: a frame is only complete at a
 * blank line, and a `data:` may legally be split across several lines.
 */
export async function* sseFrames(
  chunks: AsyncIterable<Uint8Array | string>,
): AsyncGenerator<SseFrame> {
  const decoder = new TextDecoder();
  let buffer = '';

  const drain = function* (rest: boolean): Generator<SseFrame> {
    for (;;) {
      const end = buffer.search(/\r?\n\r?\n/);
      if (end === -1) {
        if (!rest || buffer.trim() === '') return;
        const last = frameOf(buffer);
        buffer = '';
        if (last) yield last;
        return;
      }
      const raw = buffer.slice(0, end);
      buffer = buffer.slice(end).replace(/^\r?\n\r?\n/, '');
      const frame = frameOf(raw);
      if (frame) yield frame;
    }
  };

  for await (const chunk of chunks) {
    buffer += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
    yield* drain(false);
  }
  yield* drain(true);
}

const frameOf = (raw: string): SseFrame | null => {
  let event = 'message';
  const data: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (line === '' || line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '');
    if (field === 'event') event = value;
    if (field === 'data') data.push(value);
  }
  if (data.length === 0) return null;
  const body = data.join('\n');
  // `[DONE]` is Chat Completions' terminator. Responses ends the stream itself,
  // but a relay in front of either might pass one through.
  if (body === '[DONE]') return null;
  try {
    return { event, data: JSON.parse(body) };
  } catch {
    return { event, data: body };
  }
};
