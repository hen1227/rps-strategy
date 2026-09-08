"use strict";
(() => {
  // src/engine/rpsfish/engineExports.ts
  var REQUIRED_ABI_VERSION = 4;

  // src/engine/rpsfish/protocol.ts
  var ENGINE_MODE_CODES = {
    V5: 1,
    V3: 2,
    V6: 3
  };
  var RPSFISH_TOURNAMENT_NOTICE = "RPSFish is disabled for Intransitive until after the official tournament.";
  var ENGINE_TOURNAMENT_DISABLED_MODES = /* @__PURE__ */ new Set();
  var engineUnavailableMessage = (modeId) => modeId !== void 0 && ENGINE_TOURNAMENT_DISABLED_MODES.has(modeId) ? RPSFISH_TOURNAMENT_NOTICE : null;
  var STOP_REASONS = [
    "depth",
    "nodes",
    "time",
    "cancelled",
    "terminal",
    "repetition",
    "no-legal-move",
    // Index 7 because the engine numbers it 7. The order here *is* the ABI —
    // `stop_reason_code` in `RPSFish/src/wasm.rs` — so a reason is appended and
    // never inserted.
    "no-capture"
  ];
  var squareFromIndex = (index) => ({
    x: index % 9,
    y: Math.floor(index / 9)
  });
  var squareIndex = ({ x, y }) => y * 9 + x;

  // src/errors.ts
  var failureMessage = (caught, fallback = "Something went wrong.") => caught instanceof Error && caught.message ? caught.message : fallback;

  // src/engine/rpsfish/session.ts
  var withoutLock = (unit) => unit();
  var COLOR_CODES = { Red: 0, Blue: 1 };
  var PIECE_OFFSETS = {
    "Red:Rock": 0,
    "Red:Paper": 1,
    "Red:Scissors": 2,
    "Blue:Rock": 3,
    "Blue:Paper": 4,
    "Blue:Scissors": 5
  };
  var ENGINE_CAPS = {
    maxDepth: 127,
    maxNodes: 1e8,
    maxTimeMs: 12e4,
    maxVariations: 8,
    maxThrottleMs: 250
  };
  var REVIEW_CAPS = {
    maxDepth: 40,
    maxNodes: 8e6,
    maxTimeMs: 2e4,
    maxVariations: 8,
    maxThrottleMs: 250
  };
  var now = () => globalThis.performance?.now?.() ?? Date.now();
  var wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
  var halves = (value) => [
    BigInt.asUintN(64, value),
    BigInt.asUintN(64, value >> 64n)
  ];
  var encodePosition = (position) => {
    const boards = Array.from({ length: 8 }, () => 0n);
    for (const row of position.grid) {
      for (const tile of row) {
        const bit = 1n << BigInt(tile.y * 9 + tile.x);
        if (tile.occupant !== "Empty") {
          const offset = PIECE_OFFSETS[`${tile.occupantOwner}:${tile.occupant}`];
          if (offset === void 0) throw new Error("The board contains an unknown piece.");
          boards[offset] |= bit;
        }
        if (tile.ownerColor === "Red") boards[6] |= bit;
        if (tile.ownerColor === "Blue") boards[7] |= bit;
      }
    }
    return boards.flatMap(halves);
  };
  var encodeEnginePosition = (position) => {
    const unavailable = engineUnavailableMessage(position.modeId);
    if (unavailable) throw new Error(unavailable);
    const mode = ENGINE_MODE_CODES[position.modeId];
    const side = COLOR_CODES[position.currentTurn];
    if (mode === void 0 || side === void 0) {
      throw new Error("RPSFish does not support this game mode or side.");
    }
    return [mode, side, position.moveNumber, ...encodePosition(position)];
  };
  var positionKeys = /* @__PURE__ */ new WeakMap();
  var enginePositionKey = (position) => {
    const known = positionKeys.get(position);
    if (known !== void 0) return known;
    const key = encodeEnginePosition(position).map((value) => value.toString()).join(":");
    positionKeys.set(position, key);
    return key;
  };
  var sameKeys = (left, right) => left !== void 0 && right !== void 0 && left.length === right.length && left.every((key, index) => key === right[index]);
  var sharedPrefixLength = (left, right) => {
    if (!left) return 0;
    const limit = Math.min(left.length, right.length);
    let shared = 0;
    while (shared < limit && left[shared] === right[shared]) shared += 1;
    return shared;
  };
  var boundedInteger = (value, fallback, minimum, maximum) => {
    const parsed = value !== void 0 && Number.isFinite(value) ? Math.floor(value) : fallback;
    return Math.max(minimum, Math.min(maximum, parsed));
  };
  var normalizeOptions = (rawOptions, caps = ENGINE_CAPS) => {
    const options = rawOptions ?? {};
    return {
      maxDepth: boundedInteger(options.maxDepth, 8, 1, caps.maxDepth),
      maxNodes: boundedInteger(options.maxNodes, 5e5, 1, caps.maxNodes),
      maxTimeMs: boundedInteger(options.maxTimeMs, 3e3, 1, caps.maxTimeMs),
      throttleMs: boundedInteger(options.throttleMs, 16, 0, caps.maxThrottleMs),
      variations: boundedInteger(options.variations, 3, 1, caps.maxVariations)
    };
  };
  var sameMove = (line, movement) => line.from.x === movement.from.x && line.from.y === movement.from.y && line.to.x === movement.to.x && line.to.y === movement.to.y;
  var rejected = (count) => new Error(count === -2 ? "RPSFish rejected the board position." : "Invalid analysis request.");
  var engineLines = (raw) => raw.lines.map((line, index) => ({
    from: squareFromIndex(line.from),
    to: squareFromIndex(line.to),
    score: line.score,
    principalVariation: Array.from(
      { length: Math.floor(line.principalVariation.length / 2) },
      (_unused, ply) => ({
        from: squareFromIndex(line.principalVariation[ply * 2]),
        to: squareFromIndex(line.principalVariation[ply * 2 + 1])
      })
    ),
    rank: index + 1
  }));
  var readAnalysis = (raw, position, cumulativeNodes, started) => {
    const elapsedMs = Math.max(1, Math.round(now() - started));
    const stopReason = STOP_REASONS[raw.stopReason] ?? "unknown";
    return {
      confidence: raw.confidence,
      depth: raw.depth,
      elapsedMs,
      lines: engineLines(raw),
      nodes: cumulativeNodes,
      nodesPerSecond: Math.round(cumulativeNodes * 1e3 / elapsedMs),
      redScore: position.currentTurn === "Red" ? raw.score : -raw.score,
      score: raw.score,
      selectiveDepth: raw.selectiveDepth,
      stopReason
    };
  };
  var createEngine = (backend, lock = withoutLock) => {
    let warmSearchKeys;
    let warmHistoryKeys;
    const standOn = async (history, current) => {
      const historyKeys = history.map(enginePositionKey);
      const searching = [...historyKeys, enginePositionKey(current)];
      if (!sameKeys(warmSearchKeys, historyKeys) && !sameKeys(warmSearchKeys, searching)) {
        await backend.searchClear();
      }
      const shared = sharedPrefixLength(warmHistoryKeys, historyKeys);
      if (warmHistoryKeys?.length === shared && historyKeys.length > shared) {
        for (let index = shared; index < history.length; index += 1) {
          if (!await backend.historyPush(encodeEnginePosition(history[index]))) {
            throw new Error("RPSFish rejected a position in the game history.");
          }
        }
      } else if (!sameKeys(warmHistoryKeys, historyKeys)) {
        const rejected2 = await backend.historySet(history.map(encodeEnginePosition));
        if (rejected2 >= 0) throw new Error("RPSFish rejected a position in the game history.");
      }
      warmHistoryKeys = historyKeys;
      warmSearchKeys = searching;
    };
    const searchOnce = (history, position, limits, rootMoves) => lock(async () => {
      await standOn(history, position);
      if (rootMoves) {
        const index = await backend.rootFilter(rootMoves);
        if (index >= 0) throw new Error("RPSFish rejected a move in the review.");
      }
      const started = now();
      const raw = await backend.analyze(
        encodeEnginePosition(position),
        limits.maxDepth,
        limits.maxNodes,
        limits.maxTimeMs,
        limits.variations
      );
      if (raw.count < 0) throw rejected(raw.count);
      return { raw, started };
    });
    const analyze = async (position, rawOptions, onUpdate, cancelled) => {
      const options = normalizeOptions(rawOptions);
      const history = position.history ?? [];
      const started = now();
      let cumulativeNodes = 0;
      let lastCompletedDepth = -1;
      let latest;
      for (let targetDepth = 1; targetDepth <= options.maxDepth; targetDepth += 1) {
        if (cancelled()) return void 0;
        const remainingNodes = options.maxNodes - cumulativeNodes;
        const remainingTimeMs = options.maxTimeMs - Math.round(now() - started);
        if (targetDepth > 1 && (remainingNodes <= 0 || remainingTimeMs <= 0)) break;
        const { raw } = await searchOnce(history, position, {
          maxDepth: targetDepth,
          maxNodes: Math.max(1, remainingNodes),
          maxTimeMs: Math.max(1, remainingTimeMs),
          variations: options.variations
        });
        if (cancelled()) return void 0;
        cumulativeNodes += raw.nodes;
        latest = readAnalysis(raw, position, cumulativeNodes, started);
        const exactDepthZero = [
          "terminal",
          "repetition",
          "no-legal-move",
          "no-capture"
        ].includes(latest.stopReason);
        if (latest.depth > lastCompletedDepth && (latest.depth > 0 || exactDepthZero)) {
          lastCompletedDepth = latest.depth;
          onUpdate(latest);
        }
        if (latest.depth < targetDepth || latest.stopReason === "nodes" || latest.stopReason === "time" || targetDepth === options.maxDepth) {
          break;
        }
        await wait(options.throttleMs);
      }
      if (latest && latest.depth < options.maxDepth) {
        if (cumulativeNodes >= options.maxNodes) {
          latest = { ...latest, stopReason: "nodes" };
        } else if (now() - started >= options.maxTimeMs) {
          latest = { ...latest, stopReason: "time" };
        }
      }
      return latest;
    };
    const review = async (data, onEntry, cancelled) => {
      const options = normalizeOptions(data.options, REVIEW_CAPS);
      const positions = data.positions ?? [];
      const moves = data.moves ?? [];
      const from = boundedInteger(data.analyzeFrom, 0, 0, positions.length);
      const entries = [];
      for (let index = from; index < positions.length; index += 1) {
        if (cancelled()) return void 0;
        const position = positions[index];
        if (!position) break;
        const history = positions.slice(0, index);
        const searchLimits = {
          maxDepth: options.maxDepth,
          maxNodes: options.maxNodes,
          maxTimeMs: options.maxTimeMs,
          variations: options.variations
        };
        const { raw, started } = await searchOnce(history, position, searchLimits);
        const analysis = readAnalysis(raw, position, raw.nodes, started);
        const played = moves[index] ?? null;
        let playedScore = null;
        let playedLine = null;
        let baselineScore = analysis.lines[0]?.score ?? null;
        if (played) {
          const known = analysis.lines.find((line) => sameMove(line, played));
          const best = analysis.lines[0];
          if (known) {
            playedScore = known.score;
            playedLine = known;
          } else if (best) {
            const pairedSearch = await searchOnce(
              history,
              position,
              { ...searchLimits, variations: 2 },
              [{ from: best.from, to: best.to }, played]
            );
            const paired = readAnalysis(
              pairedSearch.raw,
              position,
              pairedSearch.raw.nodes,
              pairedSearch.started
            );
            const scored = paired.lines.find((line) => sameMove(line, played));
            const pairedBest = paired.lines.find((line) => sameMove(line, best));
            if (scored && pairedBest) {
              playedScore = scored.score;
              playedLine = scored;
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
          playedVariation: playedLine?.principalVariation ?? null
        };
        entries.push(entry);
        onEntry(entry, positions.length);
        await wait(options.throttleMs);
      }
      return entries;
    };
    return { analyze, review };
  };
  var createSessionHost = (engine, postMessage) => {
    let activeRequestId;
    const handleMessage = async (data) => {
      if (data?.type === "cancel") {
        if (activeRequestId === data.requestId) activeRequestId = void 0;
        return;
      }
      if (data?.type !== "analyze" && data?.type !== "review") return;
      const previousRequestId = activeRequestId;
      if (previousRequestId !== void 0 && previousRequestId !== data.requestId) {
        postMessage({ type: "cancelled", requestId: previousRequestId });
      }
      activeRequestId = data.requestId;
      const cancelled = () => activeRequestId !== data.requestId;
      if (data.type === "review") {
        try {
          const entries = await engine.review(
            data,
            (entry, total) => {
              if (!cancelled()) {
                postMessage({ type: "review-progress", requestId: data.requestId, entry, total });
              }
            },
            cancelled
          );
          if (!cancelled() && entries) {
            postMessage({ type: "review", requestId: data.requestId, entries });
            activeRequestId = void 0;
          }
        } catch (error) {
          if (!cancelled()) {
            postMessage({
              type: "error",
              requestId: data.requestId,
              message: failureMessage(error, "RPSFish review failed.")
            });
            activeRequestId = void 0;
          }
        }
        return;
      }
      try {
        const analysis = await engine.analyze(
          data.position,
          data.options,
          (update) => {
            if (!cancelled()) {
              postMessage({ type: "analysis-update", requestId: data.requestId, analysis: update });
            }
          },
          cancelled
        );
        if (!cancelled() && analysis) {
          postMessage({ type: "analysis", requestId: data.requestId, analysis });
          activeRequestId = void 0;
        }
      } catch (error) {
        if (!cancelled()) {
          postMessage({
            type: "error",
            requestId: data.requestId,
            message: failureMessage(error, "RPSFish analysis failed.")
          });
          activeRequestId = void 0;
        }
      }
    };
    const cancelAll = () => {
      activeRequestId = void 0;
    };
    return { cancelAll, handleMessage };
  };

  // src/engine/rpsfish/worker/index.ts
  var now2 = () => self.performance?.now?.() ?? Date.now();
  var enginePromise;
  var loadEngine = async () => {
    if (!enginePromise) {
      enginePromise = (async () => {
        const wasmUrl = new URL("./rpsfish.wasm", self.location.href);
        wasmUrl.search = self.location.search;
        const response = await fetch(wasmUrl);
        if (!response.ok) {
          throw new Error(`RPSFish failed to load (${response.status}).`);
        }
        const imports = { env: { rpsfish_now_ms: now2 } };
        let instance;
        if (WebAssembly.instantiateStreaming) {
          try {
            ({ instance } = await WebAssembly.instantiateStreaming(response.clone(), imports));
          } catch {
          }
        }
        if (!instance) {
          ({ instance } = await WebAssembly.instantiate(await response.arrayBuffer(), imports));
        }
        const exports = instance.exports;
        if (exports.rpsfish_abi_version() !== REQUIRED_ABI_VERSION) {
          throw new Error("This RPSFish worker and engine build are incompatible.");
        }
        return exports;
      })();
    }
    return enginePromise;
  };
  var EMPTY_ANALYSIS = {
    confidence: 0,
    depth: 0,
    lines: [],
    nodes: 0,
    score: 0,
    selectiveDepth: 0,
    stopReason: 0
  };
  var principalVariation = (engine, lineIndex) => {
    const plies = engine.rpsfish_analysis_pv_length(lineIndex);
    const flat = [];
    for (let ply = 0; ply < plies; ply += 1) {
      flat.push(
        engine.rpsfish_analysis_pv_from(lineIndex, ply),
        engine.rpsfish_analysis_pv_to(lineIndex, ply)
      );
    }
    return flat;
  };
  var wasmBackend = {
    analyze: async (encoded, maxDepth, maxNodes, maxTimeMs, variations) => {
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
          principalVariation: principalVariation(engine, index)
        })),
        nodes: engine.rpsfish_analysis_nodes(),
        score: engine.rpsfish_analysis_score(),
        selectiveDepth: engine.rpsfish_analysis_selective_depth(),
        stopReason: engine.rpsfish_analysis_stop_reason()
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
    }
  };
  var host = createSessionHost(createEngine(wasmBackend), (message) => self.postMessage(message));
  self.onmessage = ({ data }) => {
    void host.handleMessage(data);
  };
})();
