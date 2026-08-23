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

import {
  REQUIRED_ABI_VERSION,
  type EncodedPosition,
  type RPSFishExports,
} from '../engineExports';
import {
  STOP_REASONS,
  squareFromIndex,
  squareIndex,
  type Analysis,
  type AnalyzePositionRequest,
  type EngineCaps,
  type EngineLine,
  type ReviewEntry,
  type ReviewRequest,
  type SearchLimits,
  type StopReason,
  type WorkerRequest,
  type WorkerResponse,
} from '../protocol';
import type { EnginePosition } from '../../analysisGame';
import { failureMessage } from '@/errors';
import type { Move } from '@/types/game';

/** The worker's own global, typed for the handful of things it touches. */
declare const self: {
  performance?: { now?: () => number };
  location: { href: string; search: string };
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
  postMessage: (message: WorkerResponse) => void;
};

const MODE_CODES: Record<string, number> = { V1: 0, V5: 1, V3: 2 };
const COLOR_CODES: Record<string, number> = { Red: 0, Blue: 1 };
const PIECE_OFFSETS: Record<string, number> = {
  'Red:Rock': 0,
  'Red:Paper': 1,
  'Red:Scissors': 2,
  'Blue:Rock': 3,
  'Blue:Paper': 4,
  'Blue:Scissors': 5,
};

const ENGINE_CAPS: EngineCaps = {
  maxDepth: 127,
  maxNodes: 100_000_000,
  maxTimeMs: 120_000,
  maxVariations: 8,
  maxThrottleMs: 250,
};

// Per-position ceilings for a whole-game review. A review is one budget spent
// across a hundred positions rather than one position, so its caps are the
// caps of a single step multiplied by nothing: the screen stays responsive
// because each step is small, not because the total is bounded.
const REVIEW_CAPS: EngineCaps = {
  maxDepth: 40,
  maxNodes: 8_000_000,
  maxTimeMs: 20_000,
  maxVariations: 8,
  maxThrottleMs: 250,
};

let activeRequestId: number | undefined;
let enginePromise: Promise<RPSFishExports> | undefined;
// What the engine is currently standing on, as engine-position keys: the game
// line its search table was filled from, and the positions pushed into its
// repetition history. A request that continues the same line keeps both rather
// than rebuilding them, which is where a review's speed comes from.
let warmSearchKeys: string[] | undefined;
let warmHistoryKeys: string[] | undefined;

const sameKeys = (left: string[] | undefined, right: string[] | undefined) =>
  left !== undefined &&
  right !== undefined &&
  left.length === right.length &&
  left.every((key, index) => key === right[index]);

const now = () => self.performance?.now?.() ?? Date.now();
const wait = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

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

// Split one 128-bit board into the two `i64` words the engine takes. These
// stay `bigint`: the WASM parameters are `i64`, which rejects a `number`.
const halves = (value: bigint): bigint[] => [
  BigInt.asUintN(64, value),
  BigInt.asUintN(64, value >> 64n),
];

const encodePosition = (position: EnginePosition): bigint[] => {
  const boards = Array.from({ length: 8 }, () => 0n);

  for (const row of position.grid) {
    for (const tile of row) {
      const bit = 1n << BigInt(tile.y * 9 + tile.x);
      if (tile.occupant !== 'Empty') {
        const offset = PIECE_OFFSETS[`${tile.occupantOwner}:${tile.occupant}`];
        if (offset === undefined) throw new Error('The board contains an unknown piece.');
        boards[offset] |= bit;
      }
      if (tile.ownerColor === 'Red') boards[6] |= bit;
      if (tile.ownerColor === 'Blue') boards[7] |= bit;
    }
  }

  return boards.flatMap(halves);
};

const encodeEnginePosition = (position: EnginePosition): EncodedPosition => {
  const mode = MODE_CODES[position.modeId];
  const side = COLOR_CODES[position.currentTurn];
  if (mode === undefined || side === undefined) {
    throw new Error('RPSFish does not support this game mode or side.');
  }
  return [mode, side, position.moveNumber, ...encodePosition(position)];
};

const enginePositionKey = (position: EnginePosition) =>
  encodeEnginePosition(position).map((value) => value.toString()).join(':');

const boundedInteger = (
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
) => {
  const parsed = value !== undefined && Number.isFinite(value) ? Math.floor(value) : fallback;
  return Math.max(minimum, Math.min(maximum, parsed));
};

const normalizeOptions = (
  rawOptions: Partial<SearchLimits> | undefined,
  caps: EngineCaps = ENGINE_CAPS,
): SearchLimits => {
  const options = rawOptions ?? {};
  return {
    maxDepth: boundedInteger(options.maxDepth, 8, 1, caps.maxDepth),
    maxNodes: boundedInteger(options.maxNodes, 500_000, 1, caps.maxNodes),
    maxTimeMs: boundedInteger(options.maxTimeMs, 3_000, 1, caps.maxTimeMs),
    throttleMs: boundedInteger(options.throttleMs, 16, 0, caps.maxThrottleMs),
    variations: boundedInteger(options.variations, 3, 1, caps.maxVariations),
  };
};

const sameMove = (line: Move, movement: Move) =>
  line.from.x === movement.from.x &&
  line.from.y === movement.from.y &&
  line.to.x === movement.to.x &&
  line.to.y === movement.to.y;

const principalVariation = (engine: RPSFishExports, lineIndex: number): Move[] =>
  Array.from({ length: engine.rpsfish_analysis_pv_length(lineIndex) }, (_unused, ply) => ({
    from: squareFromIndex(engine.rpsfish_analysis_pv_from(lineIndex, ply)),
    to: squareFromIndex(engine.rpsfish_analysis_pv_to(lineIndex, ply)),
  }));

const readAnalysis = (
  engine: RPSFishExports,
  position: EnginePosition,
  cumulativeNodes: number,
  started: number,
): Analysis => {
  const lines: EngineLine[] = Array.from(
    { length: engine.rpsfish_analysis_count() },
    (_unused, index) => ({
      from: squareFromIndex(engine.rpsfish_analysis_from(index)),
      to: squareFromIndex(engine.rpsfish_analysis_to(index)),
      score: engine.rpsfish_analysis_line_score(index),
      principalVariation: principalVariation(engine, index),
      rank: index + 1,
    }),
  );
  const score = engine.rpsfish_analysis_score();
  const elapsedMs = Math.max(1, Math.round(now() - started));
  const stopReason: StopReason =
    STOP_REASONS[engine.rpsfish_analysis_stop_reason()] ?? 'unknown';

  return {
    confidence: engine.rpsfish_analysis_confidence(),
    depth: engine.rpsfish_analysis_depth(),
    elapsedMs,
    lines,
    nodes: cumulativeNodes,
    nodesPerSecond: Math.round((cumulativeNodes * 1_000) / elapsedMs),
    redScore: position.currentTurn === 'Red' ? score : -score,
    score,
    selectiveDepth: engine.rpsfish_analysis_selective_depth(),
    stopReason,
  };
};

const analyze = async (
  requestId: number,
  position: AnalyzePositionRequest,
  rawOptions: Partial<SearchLimits> | undefined,
  onUpdate: (analysis: Analysis) => void,
): Promise<Analysis | undefined> => {
  const engine = await loadEngine();
  if (activeRequestId !== requestId) return undefined;
  const options = normalizeOptions(rawOptions);
  const historyKeys = (position.history ?? []).map(enginePositionKey);
  // A direct child was already searched with this exact history prefix, so its
  // transposition entries and move-ordering heuristics remain useful. Unrelated
  // positions clear the table because repetition-dependent scores cannot move
  // safely between game lines.
  if (!sameKeys(historyKeys, warmSearchKeys)) engine.rpsfish_search_clear();
  warmSearchKeys = [...historyKeys, enginePositionKey(position)];
  engine.rpsfish_history_clear();
  for (const priorPosition of position.history ?? []) {
    if (engine.rpsfish_history_push(...encodeEnginePosition(priorPosition)) < 0) {
      throw new Error('RPSFish rejected a position in the game history.');
    }
  }
  warmHistoryKeys = historyKeys;

  const encoded = encodeEnginePosition(position);
  const started = now();
  let cumulativeNodes = 0;
  let lastCompletedDepth = -1;
  let latest: Analysis | undefined;

  for (let targetDepth = 1; targetDepth <= options.maxDepth; targetDepth += 1) {
    if (activeRequestId !== requestId) return undefined;

    const remainingNodes = options.maxNodes - cumulativeNodes;
    const remainingTimeMs = options.maxTimeMs - Math.round(now() - started);
    if (remainingNodes <= 0 || remainingTimeMs <= 0) break;

    const count = engine.rpsfish_analyze(
      ...encoded,
      targetDepth,
      remainingNodes,
      remainingTimeMs,
      options.variations,
    );
    if (count < 0) {
      throw new Error(
        count === -2 ? 'RPSFish rejected the board position.' : 'Invalid analysis request.',
      );
    }

    cumulativeNodes += engine.rpsfish_analysis_nodes();
    latest = readAnalysis(engine, position, cumulativeNodes, started);
    const exactDepthZero = ['terminal', 'repetition', 'no-legal-move'].includes(latest.stopReason);
    if (latest.depth > lastCompletedDepth && (latest.depth > 0 || exactDepthZero)) {
      lastCompletedDepth = latest.depth;
      onUpdate(latest);
    }

    if (
      latest.depth < targetDepth ||
      latest.stopReason === 'nodes' ||
      latest.stopReason === 'time' ||
      targetDepth === options.maxDepth
    ) {
      break;
    }

    // Yield between depths so a new position can cancel this request and so
    // deep analysis does not monopolize the worker's event loop.
    await wait(options.throttleMs);
  }

  if (latest && latest.depth < options.maxDepth) {
    if (cumulativeNodes >= options.maxNodes) {
      latest = { ...latest, stopReason: 'nodes' };
    } else if (now() - started >= options.maxTimeMs) {
      latest = { ...latest, stopReason: 'time' };
    }
  }
  return latest;
};

// One search of one position, with an optional restriction on which root
// moves it may consider. The engine runs its own iterative deepening inside
// this call, so a review does not pay a message round trip per depth.
const analyzeOnce = (
  engine: RPSFishExports,
  position: EnginePosition,
  options: SearchLimits,
  rootMoves?: Move[],
): Analysis => {
  engine.rpsfish_root_filter_clear();
  for (const movement of rootMoves ?? []) {
    if (
      engine.rpsfish_root_filter_push(squareIndex(movement.from), squareIndex(movement.to)) < 0
    ) {
      throw new Error('RPSFish rejected a move in the review.');
    }
  }
  const started = now();
  const count = engine.rpsfish_analyze(
    ...encodeEnginePosition(position),
    options.maxDepth,
    options.maxNodes,
    options.maxTimeMs,
    options.variations,
  );
  if (count < 0) {
    throw new Error(
      count === -2 ? 'RPSFish rejected the board position.' : 'Invalid analysis request.',
    );
  }
  return readAnalysis(engine, position, engine.rpsfish_analysis_nodes(), started);
};

// Grade one game, one position at a time.
//
// Two things make this cheaper than analysing each position from scratch.
// The transposition table is never cleared, because every position is a child
// of the one before it and the whole walk is a single game line. And the
// repetition history is extended by one position per step instead of being
// rebuilt, which is the difference between linear and quadratic work over a
// long game.
//
// `analyzeFrom` is what lets a game be graded while it is still being played.
// The caller resends the whole line and names the first position it has not
// been given an entry for; everything before that index is pushed into the
// repetition history without being searched again. When the engine is already
// standing exactly there — the normal case, because a live game's requests
// arrive as a growing prefix — neither the table nor the history is rebuilt,
// so a game graded in ten instalments costs what grading it in one would.
const review = async (
  requestId: number,
  data: ReviewRequest,
  onEntry: (entry: ReviewEntry, total: number) => void,
): Promise<ReviewEntry[] | undefined> => {
  const engine = await loadEngine();
  if (activeRequestId !== requestId) return undefined;
  const options = normalizeOptions(data.options, REVIEW_CAPS);
  const positions = data.positions ?? [];
  const moves = data.moves ?? [];
  const from = boundedInteger(data.analyzeFrom, 0, 0, positions.length);

  // One list, aliased by both markers: for a review the line the table was
  // filled from and the line pushed into the history are the same line, and
  // extending it in place keeps both truthful even if the walk is abandoned
  // part way through.
  const lineKeys = positions.slice(0, from).map(enginePositionKey);
  if (!(sameKeys(lineKeys, warmSearchKeys) && sameKeys(lineKeys, warmHistoryKeys))) {
    engine.rpsfish_search_clear();
    engine.rpsfish_history_clear();
    for (let index = 0; index < from; index += 1) {
      const priorPosition = positions[index];
      if (!priorPosition) continue;
      if (engine.rpsfish_history_push(...encodeEnginePosition(priorPosition)) < 0) {
        throw new Error('RPSFish rejected a position in the game history.');
      }
    }
  }
  warmSearchKeys = lineKeys;
  warmHistoryKeys = lineKeys;

  const entries: ReviewEntry[] = [];
  for (let index = from; index < positions.length; index += 1) {
    if (activeRequestId !== requestId) return undefined;
    const position = positions[index];
    if (!position) break;
    const analysis = analyzeOnce(engine, position, options);
    const played = moves[index] ?? null;
    let playedScore: number | null = null;
    let playedLine: EngineLine | null = null;
    // What the played move is measured against. It is normally the best line
    // of this position's own search, and is restated by the paired search
    // whenever one is needed, because a loss is only a loss relative to a
    // number produced the same way.
    let baselineScore: number | null = analysis.lines[0]?.score ?? null;

    if (played) {
      const known = analysis.lines.find((line) => sameMove(line, played));
      const best = analysis.lines[0];
      if (known) {
        playedScore = known.score;
        playedLine = known;
      } else if (best) {
        // Scoring the played move in its own search would compare two numbers
        // produced under different conditions. Restricting one search to the
        // best move and the played move scores both the same way, so their
        // difference is the loss and nothing else.
        const paired = analyzeOnce(engine, position, { ...options, variations: 2 }, [
          { from: best.from, to: best.to },
          played,
        ]);
        const scored = paired.lines.find((line) => sameMove(line, played));
        const pairedBest = paired.lines.find((line) => sameMove(line, best));
        if (scored && pairedBest) {
          playedScore = scored.score;
          playedLine = scored;
          // The pair is self-consistent even when it disagrees by a point or
          // two with the unrestricted search, so the loss is read off the
          // pair rather than across the two searches.
          baselineScore = pairedBest.score;
        }
      }
    }

    const entry: ReviewEntry = {
      index,
      analysis,
      baselineScore,
      played,
      playedScore,
      playedVariation: playedLine?.principalVariation ?? null,
    };
    entries.push(entry);
    onEntry(entry, positions.length);
    // Yield so a cancelled review stops promptly and the worker stays
    // answerable while a long game is graded.
    await wait(options.throttleMs);
    if (activeRequestId !== requestId) return undefined;
    if (engine.rpsfish_history_push(...encodeEnginePosition(position)) < 0) {
      throw new Error('RPSFish rejected a position in the game history.');
    }
    lineKeys.push(enginePositionKey(position));
  }
  return entries;
};

self.onmessage = async ({ data }: MessageEvent<WorkerRequest>) => {
  if (data?.type === 'cancel') {
    if (activeRequestId === data.requestId) activeRequestId = undefined;
    return;
  }
  if (data?.type !== 'analyze' && data?.type !== 'review') return;

  const previousRequestId = activeRequestId;
  if (previousRequestId !== undefined && previousRequestId !== data.requestId) {
    self.postMessage({ type: 'cancelled', requestId: previousRequestId });
  }
  activeRequestId = data.requestId;

  if (data.type === 'review') {
    try {
      const entries = await review(data.requestId, data, (entry, total) => {
        if (activeRequestId === data.requestId) {
          self.postMessage({
            type: 'review-progress',
            requestId: data.requestId,
            entry,
            total,
          });
        }
      });
      if (activeRequestId === data.requestId && entries) {
        self.postMessage({ type: 'review', requestId: data.requestId, entries });
        activeRequestId = undefined;
      }
    } catch (error) {
      if (activeRequestId === data.requestId) {
        self.postMessage({
          type: 'error',
          requestId: data.requestId,
          message: failureMessage(error, 'RPSFish review failed.'),
        });
        activeRequestId = undefined;
      }
    }
    return;
  }

  try {
    const analysis = await analyze(data.requestId, data.position, data.options, (update) => {
      if (activeRequestId === data.requestId) {
        self.postMessage({
          type: 'analysis-update',
          requestId: data.requestId,
          analysis: update,
        });
      }
    });
    if (activeRequestId === data.requestId && analysis) {
      self.postMessage({ type: 'analysis', requestId: data.requestId, analysis });
      activeRequestId = undefined;
    }
  } catch (error) {
    if (activeRequestId === data.requestId) {
      self.postMessage({
        type: 'error',
        requestId: data.requestId,
        message: failureMessage(error, 'RPSFish analysis failed.'),
      });
      activeRequestId = undefined;
    }
  }
};
