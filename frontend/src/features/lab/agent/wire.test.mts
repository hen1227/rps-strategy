// The wire, byte by byte.
//
// Chunk boundaries fall wherever the network puts them, and the interesting bug
// in any SSE client is the one where a frame happens to be split across two
// reads. So the tests feed it deliberately awkward splits rather than tidy
// whole frames.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  functionCallOutput,
  isFunctionCall,
  messageText,
  parseUpstreamEvent,
  sseFrames,
  toolSchemas,
  type SseFrame,
} from '@/features/lab/agent/wire';
import type { ToolDescriptor } from '@/webmcp/modelContext';

const stream = async function* (chunks: string[]) {
  for (const chunk of chunks) yield chunk;
};

const framesOf = async (chunks: string[]) => {
  const out: SseFrame[] = [];
  for await (const frame of sseFrames(stream(chunks))) out.push(frame);
  return out;
};

test('a frame split across three reads is still one frame', async () => {
  const frames = await framesOf([
    'event: response.output_te',
    'xt.delta\ndata: {"delta":"Ro',
    'ck"}\n\n',
  ]);
  assert.deepEqual(frames, [
    { event: 'response.output_text.delta', data: { delta: 'Rock' } },
  ]);
});

test('several frames arriving in one read are all delivered', async () => {
  const frames = await framesOf([
    'event: a\ndata: 1\n\nevent: b\ndata: 2\n\nevent: c\ndata: 3\n\n',
  ]);
  assert.deepEqual(
    frames.map((frame) => frame.event),
    ['a', 'b', 'c'],
  );
});

test('heartbeats and terminators are not events', async () => {
  // `:` lines are keep-alives; `[DONE]` is the other API's full stop and may be
  // passed through by something in the middle.
  const frames = await framesOf([': keep-alive\n\n', 'data: [DONE]\n\n', 'event: real\ndata: {}\n\n']);
  assert.deepEqual(
    frames.map((frame) => frame.event),
    ['real'],
  );
});

test('a multi-line data field is rejoined, and CRLF is tolerated', async () => {
  const frames = await framesOf(['event: x\r\ndata: {"a":\r\ndata: 1}\r\n\r\n']);
  assert.deepEqual(frames, [{ event: 'x', data: { a: 1 } }]);
});

test('a last frame with no trailing blank line is not lost', async () => {
  const frames = await framesOf(['event: last\ndata: {"ok":true}']);
  assert.deepEqual(frames, [{ event: 'last', data: { ok: true } }]);
});

test('the events the loop cares about are recognised, and the rest ignored', () => {
  assert.deepEqual(
    parseUpstreamEvent('response.output_text.delta', { item_id: 'm1', delta: 'Ro' }),
    { type: 'text.delta', itemId: 'm1', delta: 'Ro' },
  );
  assert.deepEqual(
    parseUpstreamEvent('response.function_call_arguments.delta', { item_id: 'f1', delta: '{"a' }),
    { type: 'args.delta', itemId: 'f1', delta: '{"a' },
  );
  assert.deepEqual(
    parseUpstreamEvent('response.completed', { response: { usage: { input_tokens: 9, output_tokens: 4 } } }),
    { type: 'usage', inputTokens: 9, outputTokens: 4 },
  );
  assert.deepEqual(parseUpstreamEvent('error', { error: { message: 'rate limited' } }), {
    type: 'failed',
    message: 'rate limited',
  });
  // Our relay's own frame, namespaced so it can never shadow a real one.
  assert.deepEqual(parseUpstreamEvent('rps.error', { message: 'the connection ended early' }), {
    type: 'failed',
    message: 'the connection ended early',
  });
  // An event this page has never heard of is not an error: the API grows.
  assert.equal(parseUpstreamEvent('response.reasoning_summary.delta', { delta: 'x' }), null);
  assert.equal(parseUpstreamEvent('response.output_item.done', {}), null);
});

test('tools go over as declarations, never as strict', () => {
  const tools: ToolDescriptor[] = [
    {
      name: 'lab_simulate',
      description: 'Play it against itself.',
      inputSchema: { type: 'object', properties: { games: { type: 'integer' } }, additionalProperties: false },
      execute: async () => ({}),
    },
    { name: 'lab_get_state', description: 'Everything.', execute: async () => ({}) },
  ];

  const [simulate, state] = toolSchemas(tools);
  assert.deepEqual(simulate, {
    type: 'function',
    name: 'lab_simulate',
    description: 'Play it against itself.',
    parameters: { type: 'object', properties: { games: { type: 'integer' } }, additionalProperties: false },
    // Strict would additionally demand every property be required, and
    // `lab_simulate` takes games, strength and seed or none of them.
    strict: false,
  });
  // A tool with no schema still gets a well-formed one rather than undefined.
  assert.deepEqual(state?.parameters, { type: 'object', properties: {}, additionalProperties: false });
});

test('the items we build and read', () => {
  assert.deepEqual(functionCallOutput('c-1', '{"ok":true}'), {
    type: 'function_call_output',
    call_id: 'c-1',
    output: '{"ok":true}',
  });
  assert.equal(isFunctionCall({ type: 'function_call', call_id: 'c-1' }), true);
  assert.equal(isFunctionCall({ type: 'message' }), false);
  assert.equal(
    messageText({ type: 'message', content: [{ type: 'output_text', text: 'Rock ' }, { type: 'output_text', text: 'wins.' }] }),
    'Rock wins.',
  );
});
