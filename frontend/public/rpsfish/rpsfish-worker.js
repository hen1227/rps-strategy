const MODE_CODES = { V1: 0, V5: 1, V3: 2 };
const COLOR_CODES = { Red: 0, Blue: 1 };
const PIECE_OFFSETS = {
  'Red:Rock': 0,
  'Red:Paper': 1,
  'Red:Scissors': 2,
  'Blue:Rock': 3,
  'Blue:Paper': 4,
  'Blue:Scissors': 5,
};
const STOP_REASONS = [
  'depth',
  'nodes',
  'time',
  'cancelled',
  'terminal',
  'repetition',
  'no-legal-move',
];

const ENGINE_CAPS = {
  maxDepth: 127,
  maxNodes: 100_000_000,
  maxTimeMs: 120_000,
  maxVariations: 3,
  maxThrottleMs: 250,
};

let activeRequestId;
let enginePromise;
let warmLineageKeys;

const now = () => self.performance?.now?.() ?? Date.now();
const wait = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

const loadEngine = async () => {
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
      let instance;
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
      if (instance.exports.rpsfish_abi_version() !== 3) {
        throw new Error('This RPSFish worker and engine build are incompatible.');
      }
      return instance.exports;
    })();
  }
  return enginePromise;
};

const halves = (value) => [
  BigInt.asUintN(64, value),
  BigInt.asUintN(64, value >> 64n),
];

const encodePosition = (position) => {
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

const square = (index) => ({ x: index % 9, y: Math.floor(index / 9) });

const encodeEnginePosition = (position) => {
  const mode = MODE_CODES[position.modeId];
  const side = COLOR_CODES[position.currentTurn];
  if (mode === undefined || side === undefined) {
    throw new Error('RPSFish does not support this game mode or side.');
  }
  return [mode, side, position.moveNumber, ...encodePosition(position)];
};

const enginePositionKey = (position) =>
  encodeEnginePosition(position).map((value) => value.toString()).join(':');

const boundedInteger = (value, fallback, minimum, maximum) => {
  const parsed = Number.isFinite(value) ? Math.floor(value) : fallback;
  return Math.max(minimum, Math.min(maximum, parsed));
};

const normalizeOptions = (rawOptions) => {
  const options = rawOptions ?? {};
  return {
    maxDepth: boundedInteger(options.maxDepth, 8, 1, ENGINE_CAPS.maxDepth),
    maxNodes: boundedInteger(options.maxNodes, 500_000, 1, ENGINE_CAPS.maxNodes),
    maxTimeMs: boundedInteger(options.maxTimeMs, 3_000, 1, ENGINE_CAPS.maxTimeMs),
    throttleMs: boundedInteger(options.throttleMs, 16, 0, ENGINE_CAPS.maxThrottleMs),
    variations: boundedInteger(options.variations, 3, 1, ENGINE_CAPS.maxVariations),
  };
};

const principalVariation = (engine, lineIndex) =>
  Array.from(
    { length: engine.rpsfish_analysis_pv_length(lineIndex) },
    (_, ply) => ({
      from: square(engine.rpsfish_analysis_pv_from(lineIndex, ply)),
      to: square(engine.rpsfish_analysis_pv_to(lineIndex, ply)),
    }),
  );

const readAnalysis = (engine, position, cumulativeNodes, started) => {
  const lines = Array.from({ length: engine.rpsfish_analysis_count() }, (_, index) => ({
    from: square(engine.rpsfish_analysis_from(index)),
    to: square(engine.rpsfish_analysis_to(index)),
    score: engine.rpsfish_analysis_line_score(index),
    principalVariation: principalVariation(engine, index),
    rank: index + 1,
  }));
  const score = engine.rpsfish_analysis_score();
  const elapsedMs = Math.max(1, Math.round(now() - started));

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
    stopReason: STOP_REASONS[engine.rpsfish_analysis_stop_reason()] ?? 'unknown',
  };
};

const analyze = async (requestId, position, rawOptions, onUpdate) => {
  const engine = await loadEngine();
  if (activeRequestId !== requestId) return undefined;
  const options = normalizeOptions(rawOptions);
  const historyKeys = (position.history ?? []).map(enginePositionKey);
  const continuesWarmSearch =
    warmLineageKeys !== undefined &&
    historyKeys.length === warmLineageKeys.length &&
    historyKeys.every((key, index) => key === warmLineageKeys[index]);
  // A direct child was already searched with this exact history prefix, so its
  // transposition entries and move-ordering heuristics remain useful. Unrelated
  // positions clear the table because repetition-dependent scores cannot move
  // safely between game lines.
  if (!continuesWarmSearch) engine.rpsfish_search_clear();
  warmLineageKeys = [...historyKeys, enginePositionKey(position)];
  engine.rpsfish_history_clear();
  for (const priorPosition of position.history ?? []) {
    if (engine.rpsfish_history_push(...encodeEnginePosition(priorPosition)) < 0) {
      throw new Error('RPSFish rejected a position in the game history.');
    }
  }

  const [mode, side, moveNumber, ...encoded] = encodeEnginePosition(position);
  const started = now();
  let cumulativeNodes = 0;
  let lastCompletedDepth = -1;
  let latest;

  for (let targetDepth = 1; targetDepth <= options.maxDepth; targetDepth += 1) {
    if (activeRequestId !== requestId) return undefined;

    const remainingNodes = options.maxNodes - cumulativeNodes;
    const remainingTimeMs = options.maxTimeMs - Math.round(now() - started);
    if (remainingNodes <= 0 || remainingTimeMs <= 0) break;

    const count = engine.rpsfish_analyze(
      mode,
      side,
      moveNumber,
      ...encoded,
      targetDepth,
      remainingNodes,
      remainingTimeMs,
      options.variations,
    );
    if (count < 0) {
      throw new Error(
        count === -2
          ? 'RPSFish rejected the board position.'
          : 'Invalid analysis request.',
      );
    }

    cumulativeNodes += engine.rpsfish_analysis_nodes();
    latest = readAnalysis(engine, position, cumulativeNodes, started);
    const exactDepthZero = ['terminal', 'repetition', 'no-legal-move'].includes(
      latest.stopReason,
    );
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

self.onmessage = async ({ data }) => {
  if (data?.type === 'cancel') {
    if (activeRequestId === data.requestId) activeRequestId = undefined;
    return;
  }
  if (data?.type !== 'analyze') return;

  const previousRequestId = activeRequestId;
  if (previousRequestId !== undefined && previousRequestId !== data.requestId) {
    self.postMessage({ type: 'cancelled', requestId: previousRequestId });
  }
  activeRequestId = data.requestId;

  try {
    const analysis = await analyze(
      data.requestId,
      data.position,
      data.options,
      (update) => {
        if (activeRequestId === data.requestId) {
          self.postMessage({
            type: 'analysis-update',
            requestId: data.requestId,
            analysis: update,
          });
        }
      },
    );
    if (activeRequestId === data.requestId && analysis) {
      self.postMessage({ type: 'analysis', requestId: data.requestId, analysis });
      activeRequestId = undefined;
    }
  } catch (error) {
    if (activeRequestId === data.requestId) {
      self.postMessage({
        type: 'error',
        requestId: data.requestId,
        message: error instanceof Error ? error.message : 'RPSFish analysis failed.',
      });
      activeRequestId = undefined;
    }
  }
};
