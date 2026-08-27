// The page's own way in, against each kind of browser underneath it.
//
// The case that matters is a browser that *has* WebMCP. There, `registerTools`
// hands every tool to Chrome and Chrome keeps its own registry, which the page
// cannot read back — so if the page does not mirror what it registered, its own
// agent asks what it can do and is told "nothing", on exactly the browser the
// Lab exists for. That failure is invisible from the screen: the tools really
// are registered, and a real agent really can call them. Only the page's own
// agent is blind. Hence these.

import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import {
  UnknownToolError,
  callTool,
  registerTools,
  registeredTools,
  type ToolDescriptor,
} from '@/webmcp/modelContext';

/** A tool that records how it was called. */
const spyTool = (name: string): ToolDescriptor & { calls: unknown[] } => {
  const calls: unknown[] = [];
  return {
    name,
    description: `the ${name} tool`,
    inputSchema: { type: 'object', properties: { note: { type: 'string' } } },
    calls,
    execute: async (input, options) => {
      calls.push({ input, origin: options?.origin, aborted: options?.signal?.aborted });
      return { summary: `${name} ran` };
    },
  };
};

/** Somebody else's `document.modelContext` — the origin-trial case. */
const installRealContext = () => {
  const registered = new Map<string, unknown>();
  const context = {
    registerTool: (tool: unknown) => {
      registered.set((tool as { name: string }).name, tool);
      return Promise.resolve();
    },
    unregisterTool: (name: string) => {
      registered.delete(name);
      return Promise.resolve();
    },
  };
  (globalThis as { document?: unknown }).document = { modelContext: context };
  return registered;
};

afterEach(() => {
  delete (globalThis as { document?: unknown }).document;
});

test('a page with a real modelContext can still list its own tools', () => {
  const theirs = installRealContext();
  const release = registerTools([spyTool('lab_patch_spec'), spyTool('lab_validate')]);

  // Chrome got them...
  assert.deepEqual([...theirs.keys()], ['lab_patch_spec', 'lab_validate']);
  // ...and so did the page, which is the part that used to be empty.
  assert.deepEqual(
    registeredTools().map((tool) => tool.name),
    ['lab_patch_spec', 'lab_validate'],
  );

  release();
  assert.deepEqual(registeredTools(), []);
});

test('callTool runs the same closure the browser was handed', async () => {
  const theirs = installRealContext();
  const tool = spyTool('lab_validate');
  const release = registerTools([tool]);

  const mine = await callTool('lab_validate', { note: 'from the page' }, { origin: 'lab-agent' });
  // Not "a tool of the same name": the identical object.
  assert.equal(theirs.get('lab_validate'), registeredTools()[0]);
  assert.equal(mine.content[0]?.text, 'lab_validate ran');
  assert.deepEqual(tool.calls, [
    { input: { note: 'from the page' }, origin: 'lab-agent', aborted: undefined },
  ]);

  release();
});

test('a tool that is not registered says so, and says what is', async () => {
  installRealContext();
  const release = registerTools([spyTool('lab_validate')]);

  // The surface shrinks when a test game ends, so this is an ordinary event
  // rather than a hallucination: the answer has to be useful enough to re-plan
  // from, which means naming what *is* there.
  await assert.rejects(
    () => callTool('lab_play_move', { from: 'd7', to: 'd6' }),
    (error: unknown) => {
      assert.ok(error instanceof UnknownToolError);
      assert.equal(error.tool, 'lab_play_move');
      assert.deepEqual(error.available, ['lab_validate']);
      return true;
    },
  );

  release();
});

test('with no browser agent the shim answers, and forwards the caller options', async () => {
  // No `document.modelContext`: the shim installs itself and becomes the page's
  // registry. The page's agent must not be able to tell the difference.
  (globalThis as { document?: unknown }).document = {};
  const tool = spyTool('lab_get_state');
  const release = registerTools([tool]);

  assert.deepEqual(
    registeredTools().map((entry) => entry.name),
    ['lab_get_state'],
  );

  const shim = (globalThis as unknown as {
    document: { modelContext: Record<string, (...args: unknown[]) => unknown> };
  }).document.modelContext;
  assert.ok(shim, 'the shim installs itself on document');

  const controller = new AbortController();
  controller.abort();
  // Through the shim's own executeTool — the door an extension uses. It used to
  // drop this third argument, taking the abort signal and the origin with it.
  const answer = await shim.executeTool('lab_get_state', {}, {
    origin: 'lab-agent',
    signal: controller.signal,
  });
  assert.equal((answer as { content: { text: string }[] }).content[0]?.text, 'lab_get_state ran');
  assert.deepEqual(tool.calls, [{ input: {}, origin: 'lab-agent', aborted: true }]);

  release();
});
