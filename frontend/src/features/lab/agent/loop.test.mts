// The loop, against a scripted model and tools made of plain objects.
//
// No network, no browser, no key. Everything interesting about this loop is a
// failure — arguments that are not JSON, a tool that vanished between two calls
// the model asked for together, a person declining to publish, a Stop pressed
// mid-flight — and none of those are things you can arrange reliably against a
// real model. So they are arranged here instead.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { TOTAL_WAR_SPEC } from '@/engine/spec/builtin';
import { runAgent } from '@/features/lab/agent/loop';
import { applyAgentEvents, emptyChat, type AgentEvent, type ToolStep } from '@/features/lab/agent/events';
import type { AgentRequest, AgentTransport, ResponseItem, UpstreamEvent } from '@/features/lab/agent/wire';
import type { ToolDescriptor, ToolResult } from '@/webmcp/modelContext';
import type { RuleSpec } from '@/engine/spec/types';

/* ------------------------------------------------------------- the fixtures -- */

/** A model that says exactly what it is told to, one array of events per turn. */
const scripted = (turns: UpstreamEvent[][]) => {
  const seen: AgentRequest[] = [];
  let index = 0;
  const transport: AgentTransport = {
    kind: 'direct',
    async *stream(request) {
      // The conversation is mutated in place, so snapshot it to assert on.
      seen.push({ ...request, input: structuredClone(request.input) });
      for (const event of turns[index++] ?? []) yield event;
    },
  };
  return { transport, seen, turns: () => index };
};

const say = (id: string, text: string): UpstreamEvent[] => [
  { type: 'text.delta', itemId: id, delta: text },
  { type: 'item.done', item: { type: 'message', id, content: [{ type: 'output_text', text }] } },
];

const wants = (id: string, name: string, args: string): UpstreamEvent[] => [
  { type: 'item.added', item: { type: 'function_call', id, call_id: `c-${id}`, name, arguments: '' } },
  { type: 'args.delta', itemId: id, delta: args },
  { type: 'item.done', item: { type: 'function_call', id, call_id: `c-${id}`, name, arguments: args } },
];

const tool = (name: string, run: (input: Record<string, unknown>) => unknown = () => ({ summary: `${name} ran` })): ToolDescriptor => ({
  name,
  description: name,
  inputSchema: { type: 'object', properties: {} },
  execute: async (input) => run(input),
});

/** The parts of the world the loop is allowed to touch. */
const world = (tools: ToolDescriptor[]) => {
  const registry = new Map(tools.map((entry) => [entry.name, entry]));
  const calls: { name: string; input: Record<string, unknown>; origin?: string }[] = [];
  return {
    calls,
    registry,
    listTools: () => [...registry.values()],
    callTool: async (name: string, input: Record<string, unknown>, options?: { origin?: string }): Promise<ToolResult> => {
      calls.push({ name, input, origin: options?.origin });
      const found = registry.get(name);
      if (!found) throw new Error(`no tool called ${name}`);
      const value = (await found.execute(input)) as { summary?: string };
      return { content: [{ type: 'text', text: value?.summary ?? '' }], structuredContent: value };
    },
  };
};

const collect = async (events: AsyncGenerator<AgentEvent>) => {
  const out: AgentEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
};

const stepsOf = (events: AgentEvent[]): ToolStep[] =>
  applyAgentEvents(emptyChat(), events)
    .items.filter((item) => item.kind === 'step')
    .map((item) => (item as { step: ToolStep }).step);

const run = (turns: UpstreamEvent[][], tools: ToolDescriptor[], extra: Record<string, unknown> = {}) => {
  const model = scripted(turns);
  const stage = world(tools);
  const conversation: ResponseItem[] = [];
  return {
    model,
    stage,
    conversation,
    events: () =>
      collect(
        runAgent(conversation, {
          transport: model.transport,
          instructions: 'be brief',
          signal: new AbortController().signal,
          listTools: stage.listTools,
          callTool: stage.callTool,
          ...extra,
        }),
      ),
  };
};

/* ----------------------------------------------------------------- the tests -- */

test('a plain answer needs no tools and ends the run', async () => {
  const session = run([say('m1', 'Rock beats scissors.')], [tool('lab_validate')]);
  const events = await session.events();

  assert.equal(events.at(-1)?.type, 'run.ended');
  assert.deepEqual((events.at(-1) as { stop: unknown }).stop, { reason: 'complete' });
  assert.equal(session.model.turns(), 1);

  const chat = applyAgentEvents(emptyChat(), events);
  const assistant = chat.items.find((item) => item.kind === 'assistant');
  assert.equal((assistant as { text: string }).text, 'Rock beats scissors.');
  assert.equal((assistant as { streaming: boolean }).streaming, false);
});

test('a tool call runs, is attributed to this page, and its answer goes back', async () => {
  const session = run(
    [wants('f1', 'lab_validate', '{"deep":true}'), say('m1', 'It is playable.')],
    [tool('lab_validate', () => ({ summary: 'Valid.', errors: 0 }))],
  );
  const events = await session.events();

  assert.deepEqual(session.stage.calls, [
    { name: 'lab_validate', input: { deep: true }, origin: 'lab-agent' },
  ]);

  const [step] = stepsOf(events);
  assert.equal(step?.status, 'ok');
  assert.equal(step?.summary, 'Valid.');
  assert.equal(step?.argsText, '{"deep":true}');

  // The model's own item, then the result, keyed to it.
  const output = session.conversation.find((item) => item.type === 'function_call_output');
  assert.equal(output?.call_id, 'c-f1');
  assert.deepEqual(JSON.parse(String(output?.output)), { summary: 'Valid.', errors: 0 });
});

test('arguments that are not JSON come back as an answer, not an exception', async () => {
  const session = run(
    [wants('f1', 'lab_patch_spec', '{"patch": {'), say('m1', 'Sorry — fixed.')],
    [tool('lab_patch_spec')],
  );
  const events = await session.events();

  assert.deepEqual(session.stage.calls, [], 'a tool with unreadable arguments must not run');
  assert.equal(stepsOf(events)[0]?.status, 'rejected');
  assert.deepEqual((events.at(-1) as { stop: { reason: string } }).stop.reason, 'complete');

  // And the model was told what was wrong, so it can fix it.
  const output = session.conversation.find((item) => item.type === 'function_call_output');
  const body = JSON.parse(String(output?.output));
  assert.equal(body.error, 'the arguments were not valid JSON');
  assert.equal(body.received, '{"patch": {');
});

test('a model that will not stop sending broken arguments is cut off', async () => {
  const broken = (id: string) => wants(id, 'lab_patch_spec', '{{{');
  const session = run([broken('a'), broken('b'), broken('c'), say('m', 'never reached')], [tool('lab_patch_spec')]);
  const events = await session.events();

  const stop = (events.at(-1) as { stop: { reason: string; message?: string } }).stop;
  assert.equal(stop.reason, 'stuck');
  assert.match(String(stop.message), /not valid JSON/);
  assert.equal(session.model.turns(), 3, 'it stops rather than spending every turn');
});

test('a tool that disappeared mid-turn is refused with the list that replaced it', async () => {
  // The real shape of this: `lab_patch_spec` ends the test game, so the
  // `lab_play_move` the model asked for in the same breath is already gone.
  const stage = world([tool('lab_patch_spec'), tool('lab_play_move')]);
  const patch = tool('lab_patch_spec', () => {
    stage.registry.delete('lab_play_move');
    return { summary: 'Rules edited. The test game ended.' };
  });
  stage.registry.set('lab_patch_spec', patch);

  const model = scripted([
    [...wants('f1', 'lab_patch_spec', '{}'), ...wants('f2', 'lab_play_move', '{"from":"d7","to":"d6"}')],
    say('m1', 'Started a fresh game instead.'),
  ]);
  const conversation: ResponseItem[] = [];
  const events = await collect(
    runAgent(conversation, {
      transport: model.transport,
      instructions: '',
      signal: new AbortController().signal,
      listTools: stage.listTools,
      callTool: stage.callTool,
    }),
  );

  const [edited, moved] = stepsOf(events);
  assert.equal(edited?.status, 'ok');
  assert.equal(moved?.status, 'rejected');
  assert.deepEqual(
    stage.calls.map((call) => call.name),
    ['lab_patch_spec'],
    'the vanished tool is never called',
  );

  const refusal = JSON.parse(
    String(conversation.filter((item) => item.type === 'function_call_output').at(-1)?.output),
  );
  assert.match(refusal.error, /lab_play_move is not available/);
  assert.deepEqual(refusal.available, ['lab_patch_spec'], 'and it is told what it may use instead');
});

test('a tool that throws is a failed step, and the run carries on', async () => {
  const session = run(
    [wants('f1', 'lab_simulate', '{}'), say('m1', 'That did not work.')],
    [
      tool('lab_simulate', () => {
        throw new Error('the mode has no legal opening move');
      }),
    ],
  );
  const events = await session.events();

  const [step] = stepsOf(events);
  assert.equal(step?.status, 'failed');
  assert.equal(step?.summary, 'the mode has no legal opening move');
  assert.equal((events.at(-1) as { stop: { reason: string } }).stop.reason, 'complete');
});

test('the tool list is re-read every turn, not cached', async () => {
  const stage = world([tool('lab_validate')]);
  const model = scripted([wants('f1', 'lab_validate', '{}'), say('m1', 'done')]);
  stage.registry.set(
    'lab_validate',
    tool('lab_validate', () => {
      stage.registry.set('lab_play_move', tool('lab_play_move'));
      return { summary: 'a game started' };
    }),
  );

  await collect(
    runAgent([], {
      transport: model.transport,
      instructions: '',
      signal: new AbortController().signal,
      listTools: stage.listTools,
      callTool: stage.callTool,
    }),
  );

  assert.deepEqual(model.seen[0]?.tools.map((entry) => entry.name), ['lab_validate']);
  assert.deepEqual(
    model.seen[1]?.tools.map((entry) => entry.name),
    ['lab_validate', 'lab_play_move'],
    'the second turn is offered the tool the first turn created',
  );
  // Schemas go over as declarations the model can read, and never as strict:
  // several of these tools have genuinely optional arguments.
  assert.equal(model.seen[0]?.tools[0]?.strict, false);
});

test('stopping ends the run and leaves nothing running', async () => {
  const controller = new AbortController();
  const stage = world([
    tool('lab_publish_mode', () => {
      // Stands in for the confirmation dialog: it is still up when Stop is hit.
      controller.abort();
      return { summary: 'Not published: the person at the keyboard declined.' };
    }),
    tool('lab_validate'),
  ]);
  const model = scripted([
    [...wants('f1', 'lab_publish_mode', '{"slug":"x"}'), ...wants('f2', 'lab_validate', '{}')],
  ]);

  const events = await collect(
    runAgent([], {
      transport: model.transport,
      instructions: '',
      signal: controller.signal,
      listTools: stage.listTools,
      callTool: stage.callTool,
    }),
  );

  assert.equal((events.at(-1) as { stop: { reason: string } }).stop.reason, 'stopped');
  assert.deepEqual(
    stage.calls.map((call) => call.name),
    ['lab_publish_mode'],
    'the queued second call never runs',
  );
  // And nothing is left claiming to be in flight.
  assert.deepEqual(
    stepsOf(events).map((step) => step.status),
    ['ok', 'stopped'],
  );
});

test('a model that never finishes is bounded by its turn count', async () => {
  const forever = Array.from({ length: 10 }, (_unused, index) => wants(`f${index}`, 'lab_validate', '{}'));
  const session = run(forever, [tool('lab_validate')], { maxTurns: 3 });
  const events = await session.events();

  assert.equal((events.at(-1) as { stop: { reason: string } }).stop.reason, 'max-turns');
  assert.equal(session.model.turns(), 3);
});

test('a run that has outlived its wall clock does not start another turn', async () => {
  let clock = 0;
  const session = run([wants('f1', 'lab_validate', '{}'), say('m', 'unreachable')], [tool('lab_validate')], {
    maxWallMs: 1_000,
    now: () => (clock += 600),
  });
  const events = await session.events();

  assert.equal((events.at(-1) as { stop: { reason: string } }).stop.reason, 'max-wall');
});

test('an edit to the draft is described in the words a designer uses', async () => {
  let draft: RuleSpec = TOTAL_WAR_SPEC;
  const session = run(
    [wants('f1', 'lab_patch_spec', '{}'), say('m', 'Smaller board.')],
    [
      tool('lab_patch_spec', () => {
        draft = { ...draft, name: 'Leapfrog', board: { width: 7, height: 7 } };
        return { summary: 'Edited.' };
      }),
    ],
    { readDraft: () => draft },
  );
  const events = await session.events();

  assert.deepEqual(
    stepsOf(events)[0]?.changes.map((change) => change.label),
    ['named “Leapfrog”', 'board 9×9 → 7×7'],
  );
});
