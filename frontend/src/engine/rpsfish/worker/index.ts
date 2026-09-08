// The RPSFish worker.
//
// Bundled by `npm run build:worker` into `public/rpsfish/rpsfish-worker.js` and
// loaded from there by URL, so this file is a classic worker script rather than
// a module the app imports: everything it needs is inlined at build time and
// the emitted file has no imports at runtime.
//
// It is authored here, in TypeScript, so that the messages it posts and the
// messages `../client.ts` reads come from the same declarations — see
// `../protocol.ts`.
//
// What the worker is *not* is the engine's behaviour. Loading WebAssembly and
// forwarding ABI calls is all that is platform-specific about running RPSFish
// in a browser, and all that is left here; iterative deepening, the review
// walk and every clamp live in `../session.ts`, which iOS runs too.

import { REQUIRED_ABI_VERSION, type RPSFishExports } from '../engineExports';
import {
  createEngine,
  createSessionHost,
  type EngineBackend,
  type RawAnalysis,
  type RawLine,
} from '../session';
import { squareIndex, type WorkerRequest, type WorkerResponse } from '../protocol';

/** The worker's own global, typed for the handful of things it touches. */
declare const self: {
  performance?: { now?: () => number };
  location: { href: string; search: string };
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
  postMessage: (message: WorkerResponse) => void;
};

const now = () => self.performance?.now?.() ?? Date.now();

let enginePromise: Promise<RPSFishExports> | undefined;

const loadEngine = async (): Promise<RPSFishExports> => {
  if (!enginePromise) {
    enginePromise = (async () => {
      const wasmUrl = new URL('./rpsfish.wasm', self.location.href);
      // Use the worker's release key for the WASM too. Relative URL resolution
      // drops the worker query, which could otherwise mix cached releases.
      wasmUrl.search = self.location.search;
      const response = await fetch(wasmUrl);
      if (!response.ok) {
        throw new Error(`RPSFish failed to load (${response.status}).`);
      }

      const imports = { env: { rpsfish_now_ms: now } };
      let instance: WebAssembly.Instance | undefined;
      if (WebAssembly.instantiateStreaming) {
        try {
          ({ instance } = await WebAssembly.instantiateStreaming(response.clone(), imports));
        } catch {
          // Some static servers do not assign application/wasm yet.
        }
      }
      if (!instance) {
        ({ instance } = await WebAssembly.instantiate(await response.arrayBuffer(), imports));
      }
      const exports = instance.exports as unknown as RPSFishExports;
      if (exports.rpsfish_abi_version() !== REQUIRED_ABI_VERSION) {
        throw new Error('This RPSFish worker and engine build are incompatible.');
      }
      return exports;
    })();
  }
  return enginePromise;
};

const EMPTY_ANALYSIS = {
  confidence: 0,
  depth: 0,
  lines: [] as RawLine[],
  nodes: 0,
  score: 0,
  selectiveDepth: 0,
  stopReason: 0,
};

/**
 * The principal variation as a flat run of `from, to` square indices.
 *
 * Flat because the shape crossing this boundary is also the shape crossing the
 * iOS bridge, and one array of numbers is the cheapest thing either can carry.
 */
const principalVariation = (engine: RPSFishExports, lineIndex: number): number[] => {
  const plies = engine.rpsfish_analysis_pv_length(lineIndex);
  const flat: number[] = [];
  for (let ply = 0; ply < plies; ply += 1) {
    flat.push(
      engine.rpsfish_analysis_pv_from(lineIndex, ply),
      engine.rpsfish_analysis_pv_to(lineIndex, ply),
    );
  }
  return flat;
};

// The engine's search is synchronous here, so every method resolves without
// ever yielding. That is the whole difference between this backend and the iOS
// one, and the reason the interface is asynchronous at all.
const wasmBackend: EngineBackend = {
  analyze: async (encoded, maxDepth, maxNodes, maxTimeMs, variations): Promise<RawAnalysis> => {
    const engine = await loadEngine();
    const count = engine.rpsfish_analyze(...encoded, maxDepth, maxNodes, maxTimeMs, variations);
    if (count < 0) return { count, ...EMPTY_ANALYSIS };
    return {
      count,
      confidence: engine.rpsfish_analysis_confidence(),
      depth: engine.rpsfish_analysis_depth(),
      lines: Array.from({ length: engine.rpsfish_analysis_count() }, (_unused, index) => ({
        from: engine.rpsfish_analysis_from(index),
        to: engine.rpsfish_analysis_to(index),
        score: engine.rpsfish_analysis_line_score(index),
        principalVariation: principalVariation(engine, index),
      })),
      nodes: engine.rpsfish_analysis_nodes(),
      score: engine.rpsfish_analysis_score(),
      selectiveDepth: engine.rpsfish_analysis_selective_depth(),
      stopReason: engine.rpsfish_analysis_stop_reason(),
    };
  },

  historySet: async (history) => {
    const engine = await loadEngine();
    engine.rpsfish_history_clear();
    for (const [index, encoded] of history.entries()) {
      if (engine.rpsfish_history_push(...encoded) < 0) return index;
    }
    return -1;
  },

  historyPush: async (encoded) => {
    const engine = await loadEngine();
    return engine.rpsfish_history_push(...encoded) >= 0;
  },

  rootFilter: async (moves) => {
    const engine = await loadEngine();
    engine.rpsfish_root_filter_clear();
    for (const [index, movement] of moves.entries()) {
      if (engine.rpsfish_root_filter_push(squareIndex(movement.from), squareIndex(movement.to)) < 0) {
        return index;
      }
    }
    return -1;
  },

  searchClear: async () => {
    const engine = await loadEngine();
    engine.rpsfish_search_clear();
  },
};

const host = createSessionHost(createEngine(wasmBackend), (message) => self.postMessage(message));

self.onmessage = ({ data }: MessageEvent<WorkerRequest>) => {
  void host.handleMessage(data);
};
