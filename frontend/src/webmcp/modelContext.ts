// Talking to the browser's agent.
//
// WebMCP lets a page hand an agent real tools instead of making it guess at the
// UI: the page says what it can do, in JSON Schema, and the agent calls it. The
// specification has moved twice while being written —
// `navigator.modelContext.provideContext` became `registerTool`, `unregisterTool`
// became an `AbortSignal`, and the object itself moved from `navigator` to
// `document` — and it is behind an origin trial, so on most browsers today it is
// simply not there.
//
// So nothing in this app touches the global directly. Everything goes through
// here, which does three jobs:
//
//  1. **Finds whichever generation is present**, newest first, and reports which.
//  2. **Normalises registration**, so a caller always gets an `AbortSignal` even
//     against a build that only has `unregisterTool(name)`.
//  3. **Installs a shim when there is none.** Not a polyfill of the protocol —
//     it cannot summon an agent — but the same object shape, so the Lab's own
//     agent panel drives exactly the tools a real agent would, and an extension
//     that looks for `document.modelContext` finds one. A demo that only works
//     on one Chrome build behind one flag is a demo that does not work.

/** What a tool result looks like once this module is done with it. */
export interface ToolResult {
  content: { type: 'text'; text: string }[];
  /** The same answer as data, for a caller that would rather parse than read. */
  structuredContent?: unknown;
  isError?: boolean;
}

/**
 * What a caller may say about itself when it runs a tool.
 *
 * `origin` is deliberately public and deliberately optional. The page's own
 * agent names itself so the Lab can tell its calls from an outside agent's; a
 * browser agent says nothing and is recorded as `external`. It is a label for
 * the transcript, never a permission — a tool behaves the same whoever asks.
 */
export interface CallOptions {
  signal?: AbortSignal;
  origin?: 'lab-agent' | (string & {});
}

export interface ToolDescriptor {
  name: string;
  title?: string;
  description: string;
  inputSchema?: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean; untrustedContentHint?: boolean };
  execute: (input: Record<string, unknown>, options?: CallOptions) => Promise<unknown>;
}

/** A tool was named that is not registered right now, and what is. */
export class UnknownToolError extends Error {
  // Plain fields assigned in the body, not constructor parameter properties:
  // the `.mts` tests run under Node's type stripping, which refuses the latter
  // because they are the one TypeScript construct that emits code.
  readonly tool: string;
  readonly available: string[];

  constructor(tool: string, available: string[]) {
    super(`no tool called ${tool}`);
    this.name = 'UnknownToolError';
    this.tool = tool;
    this.available = available;
  }
}

/** Which generation of the API this page found. */
export type ModelContextFlavour = 'document' | 'navigator' | 'shim' | 'none';

interface ModelContextLike {
  registerTool: (tool: unknown, options?: { signal?: AbortSignal }) => unknown;
  unregisterTool?: (name: string) => unknown;
  getTools?: () => unknown;
  executeTool?: (tool: unknown, input?: unknown, options?: unknown) => unknown;
  addEventListener?: (type: string, listener: () => void) => void;
}

/**
 * Every tool this page is offering, and the Lab's own way in.
 *
 * Written on every registration *whatever is underneath* — that is the whole
 * point of it. When the browser has a real `document.modelContext` we hand the
 * tools to Chrome and Chrome keeps its own registry, which the page cannot read
 * back; without this mirror `registeredTools()` would answer "none" on exactly
 * the browser the Lab is built for, and the page's own agent would have nothing
 * to call.
 *
 * It holds the *wrapped* descriptors — the same closures handed to Chrome — so
 * `callTool` runs the identical function an outside agent runs. One registry,
 * whoever is asking. Two would be two answers to "what can this page do".
 */
const pageTools = new Map<string, ToolDescriptor>();
const toolListeners = new Set<() => void>();

const notifyToolsChanged = () => {
  for (const listener of toolListeners) listener();
};

/** Everything registered right now, whichever implementation is underneath. */
export const registeredTools = (): ToolDescriptor[] => [...pageTools.values()];

/**
 * Run a registered tool by name.
 *
 * The page's own agent goes through here, and this is the same door an outside
 * agent comes through: the descriptor is the object handed to `registerTool`,
 * and the answer goes through the same `asToolResult`. There is no faster path
 * for the page's own agent, on purpose — if this one is broken, the demo is
 * broken, and a private shortcut would hide that.
 */
export const callTool = async (
  name: string,
  input: Record<string, unknown> = {},
  options?: CallOptions,
): Promise<ToolResult> => {
  const tool = pageTools.get(name);
  if (!tool) throw new UnknownToolError(name, [...pageTools.keys()]);
  return asToolResult(await tool.execute(input ?? {}, options));
};

export const onToolsChanged = (listener: () => void) => {
  toolListeners.add(listener);
  return () => {
    toolListeners.delete(listener);
  };
};

/**
 * Normalise whatever a tool returned into the shape both the spec and the
 * convention accept.
 *
 * The current draft types `execute` as returning `Promise<any>`, while every
 * example returns `{ content: [...] }`. Returning a superset satisfies both, and
 * gives an agent something to read as well as something to parse — which matters
 * more than it sounds: a model that can read the board in the tool result does
 * not have to ask for it again.
 */
export const asToolResult = (value: unknown): ToolResult => {
  if (value && typeof value === 'object' && 'content' in value) {
    return value as ToolResult;
  }
  const structured = value as { summary?: unknown } | null;
  const summary =
    structured && typeof structured === 'object' && typeof structured.summary === 'string'
      ? structured.summary
      : JSON.stringify(value ?? null);
  return { content: [{ type: 'text', text: summary }], structuredContent: value };
};

const globalDocument = (): (Record<string, unknown> & ModelContextLike) | null => {
  if (typeof document === 'undefined') return null;
  return document as unknown as Record<string, unknown> & ModelContextLike;
};

/** Install the shim, once, when the browser has nothing of its own. */
const installShim = (): ModelContextLike => {
  const shim: ModelContextLike = {
    registerTool(tool, options) {
      const descriptor = tool as ToolDescriptor;
      pageTools.set(descriptor.name, descriptor);
      options?.signal?.addEventListener('abort', () => {
        pageTools.delete(descriptor.name);
        notifyToolsChanged();
      });
      notifyToolsChanged();
      return Promise.resolve();
    },
    unregisterTool(name) {
      pageTools.delete(name);
      notifyToolsChanged();
      return Promise.resolve();
    },
    getTools() {
      return Promise.resolve(
        [...pageTools.values()].map((descriptor) => ({
          name: descriptor.name,
          title: descriptor.title,
          description: descriptor.description,
          inputSchema: descriptor.inputSchema,
          annotations: descriptor.annotations,
        })),
      );
    },
    // `options` is forwarded rather than dropped: it carries the abort signal a
    // caller uses to stop a long tool, and the origin the transcript records.
    executeTool(tool, input, options) {
      const name = typeof tool === 'string' ? tool : (tool as { name?: string })?.name;
      if (!name) return Promise.reject(new Error('no tool named'));
      return callTool(name, (input ?? {}) as Record<string, unknown>, options as CallOptions);
    },
    addEventListener(type, listener) {
      if (type === 'toolchange') toolListeners.add(listener);
    },
  };
  const host = globalDocument();
  if (host) {
    try {
      Object.defineProperty(host, 'modelContext', {
        value: shim,
        configurable: true,
        writable: true,
      });
    } catch {
      // A browser that refuses the definition still gets the shim through
      // `modelContext()` below; only an outside agent loses its way in.
    }
  }
  return shim;
};

let shimInstance: ModelContextLike | null = null;

/**
 * The model-context object to use, and which kind it is.
 *
 * Never call this during a render that also runs at build time: `document` does
 * not exist in the Node pass that pre-renders these pages, and the answer would
 * differ between the two. `useModelContextTools` sits behind `useSettled` for
 * exactly this reason.
 */
export const modelContext = (): { flavour: ModelContextFlavour; context: ModelContextLike | null } => {
  const host = globalDocument();
  if (!host) return { flavour: 'none', context: null };

  const onDocument = host.modelContext as ModelContextLike | undefined;
  if (onDocument && onDocument !== shimInstance && typeof onDocument.registerTool === 'function') {
    return { flavour: 'document', context: onDocument };
  }
  const navigatorContext = (globalThis.navigator as unknown as { modelContext?: ModelContextLike })
    ?.modelContext;
  if (navigatorContext && typeof navigatorContext.registerTool === 'function') {
    // Deprecated in Chromium 150, and still what an older build offers.
    return { flavour: 'navigator', context: navigatorContext };
  }
  shimInstance ??= installShim();
  return { flavour: 'shim', context: shimInstance };
};

/**
 * Register a set of tools, and return the function that takes them away again.
 *
 * The registry is *replaced*, not added to: a page's tools are a statement about
 * what it can do right now, and the Lab's change as the draft does — there is no
 * `lab_play_move` until there is a game to play it in. Callers therefore hand
 * over the whole list every time.
 */
export const registerTools = (descriptors: ToolDescriptor[]): (() => void) => {
  const { context } = modelContext();
  if (!context) return () => {};

  const controller = new AbortController();
  const registered: string[] = [];

  for (const descriptor of descriptors) {
    const tool = {
      name: descriptor.name,
      title: descriptor.title ?? descriptor.name,
      description: descriptor.description,
      inputSchema: descriptor.inputSchema ?? { type: 'object', properties: {} },
      annotations: descriptor.annotations,
      // Whatever a tool returns, the agent sees the same shape.
      execute: async (input: Record<string, unknown>, options?: CallOptions) =>
        asToolResult(await descriptor.execute(input ?? {}, options)),
    };
    // The mirror, before the handoff and regardless of what happens to it. A
    // browser that refuses the registration still leaves the page able to
    // describe and run its own tools, which is what the Lab's agent reads.
    pageTools.set(tool.name, tool);
    try {
      // Newer builds take the signal and need no unregister; older ones ignore
      // the second argument, which is what `registered` is for.
      void context.registerTool(tool, { signal: controller.signal });
      registered.push(descriptor.name);
    } catch (error) {
      // A duplicate name throws InvalidStateError on some builds. Replacing the
      // whole set means that can happen on a re-register, so take it away first
      // and try once more rather than losing the tool for the rest of the
      // session.
      try {
        context.unregisterTool?.(descriptor.name);
        void context.registerTool(tool, { signal: controller.signal });
        registered.push(descriptor.name);
      } catch {
        void error;
      }
    }
  }

  notifyToolsChanged();

  return () => {
    controller.abort();
    for (const descriptor of descriptors) pageTools.delete(descriptor.name);
    if (typeof context.unregisterTool === 'function') {
      for (const name of registered) {
        try {
          context.unregisterTool(name);
        } catch {
          // Already gone, because the signal took it. Nothing to do.
        }
      }
    }
    notifyToolsChanged();
  };
};

/** How the page describes its own connection, for the panel's status line. */
export const describeFlavour = (flavour: ModelContextFlavour): string => {
  switch (flavour) {
    case 'document':
      return 'Connected to this browser’s agent (document.modelContext).';
    case 'navigator':
      return 'Connected to this browser’s agent (navigator.modelContext, deprecated).';
    case 'shim':
      return 'No browser agent here. Tools are live on document.modelContext and can be run below.';
    default:
      return 'Not available on this platform.';
  }
};
