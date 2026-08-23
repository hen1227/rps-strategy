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
  maxVariations: 8,
  maxThrottleMs: 250,
};

// Per-position ceilings for a whole-game review. A review is one budget spent
// across a hundred positions rather than one position, so its caps are the
// caps of a single step multiplied by nothing: the screen stays responsive
// because each step is small, not because the total is bounded.
const REVIEW_CAPS = {
  maxDepth: 40,
  maxNodes: 8_000_000,
  maxTimeMs: 20_000,
  maxVariations: 8,
  maxThrottleMs: 250,
};

let activeRequestId;
let enginePromise;
// What the engine is currently standing on, as engine-position keys: the game
// line its search table was filled from, and the positions pushed into its
// repetition history. A request that continues the same line keeps both rather
// than rebuilding them, which is where a review's speed comes from.
let warmSearchKeys;
let warmHistoryKeys;

const sameKeys = (left, right) =>
  left !== undefined &&
  right !== undefined &&
  left.length === right.length &&
  left.every((key, index) => key === right[index]);

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
      if (instance.exports.rpsfish_abi_version() !== 4) {
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

const normalizeOptions = (rawOptions, caps = ENGINE_CAPS) => {
  const options = rawOptions ?? {};
  return {
    maxDepth: boundedInteger(options.maxDepth, 8, 1, caps.maxDepth),
    maxNodes: boundedInteger(options.maxNodes, 500_000, 1, caps.maxNodes),
    maxTimeMs: boundedInteger(options.maxTimeMs, 3_000, 1, caps.maxTimeMs),
    throttleMs: boundedInteger(options.throttleMs, 16, 0, caps.maxThrottleMs),
    variations: boundedInteger(options.variations, 3, 1, caps.maxVariations),
  };
};

const sameMove = (line, movement) =>
  line.from.x === movement.from.x &&
  line.from.y === movement.from.y &&
  line.to.x === movement.to.x &&
  line.to.y === movement.to.y;

const squareIndex = ({ x, y }) => y * 9 + x;

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

// One search of one position, with an optional restriction on which root
// moves it may consider. The engine runs its own iterative deepening inside
// this call, so a review does not pay a message round trip per depth.
const analyzeOnce = (engine, position, options, rootMoves) => {
  engine.rpsfish_root_filter_clear();
  for (const movement of rootMoves ?? []) {
    if (engine.rpsfish_root_filter_push(squareIndex(movement.from), squareIndex(movement.to)) < 0) {
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
const review = async (requestId, data, onEntry) => {
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
      if (engine.rpsfish_history_push(...encodeEnginePosition(positions[index])) < 0) {
        throw new Error('RPSFish rejected a position in the game history.');
      }
    }
  }
  warmSearchKeys = lineKeys;
  warmHistoryKeys = lineKeys;

  const entries = [];
  for (let index = from; index < positions.length; index += 1) {
    if (activeRequestId !== requestId) return undefined;
    const position = positions[index];
    const analysis = analyzeOnce(engine, position, options);
    const played = moves[index] ?? null;
    let playedScore = null;
    let playedLine = null;
    // What the played move is measured against. It is normally the best line
    // of this position's own search, and is restated by the paired search
    // whenever one is needed, because a loss is only a loss relative to a
    // number produced the same way.
    let baselineScore = analysis.lines[0]?.score ?? null;

    if (played) {
      const known = analysis.lines.find((line) => sameMove(line, played));
      if (known) {
        playedScore = known.score;
        playedLine = known;
      } else if (analysis.lines.length > 0) {
        // Scoring the played move in its own search would compare two numbers
        // produced under different conditions. Restricting one search to the
        // best move and the played move scores both the same way, so their
        // difference is the loss and nothing else.
        const best = analysis.lines[0];
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

    const entry = {
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

self.onmessage = async ({ data }) => {
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
          message: error instanceof Error ? error.message : 'RPSFish review failed.',
        });
        activeRequestId = undefined;
      }
    }
    return;
  }

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
