// The RPSFish orchestration layer, once, for every platform that runs it.
//
// Two things drive RPSFish: a browser worker holding a WebAssembly instance,
// and an iOS app holding a static library. Both need the same behaviour —
// iterative deepening that streams completed depths, a review walk that keeps
// the transposition table and repetition history across a whole game, and the
// same clamping of every caller's request. None of that is platform-specific,
// so none of it lives in a platform file: the worker and the native session
// each supply an `EngineBackend` and get the behaviour from here.
//
// The split is deliberately at the ABI: a backend does nothing but forward
// calls to the engine and read the result back. Every decision about *which*
// calls to make, and in what order, is in this file.

import {
  ENGINE_MODE_CODES,
  STOP_REASONS,
  engineUnavailableMessage,
  squareFromIndex,
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
} from './protocol';
import type { EncodedPosition } from './engineExports';
import type { EnginePosition } from '../analysisGame';
import { failureMessage } from '@/errors';
import type { Move } from '@/types/game';

/** One ranked continuation as the ABI reports it: square indices, not coordinates. */
export interface RawLine {
  from: number;
  to: number;
  score: number;
  /** The principal variation as a flat run of `from, to` square indices. */
  principalVariation: number[];
}

/**
 * One completed search, read straight off the ABI.
 *
 * `count` is what `rpsfish_analyze` returned, negative included: a backend
 * reports the rejection rather than interpreting it, so the one place that
 * turns an engine refusal into a message the player sees is this file.
 */
export interface RawAnalysis {
  count: number;
  confidence: number;
  depth: number;
  lines: RawLine[];
  nodes: number;
  score: number;
  selectiveDepth: number;
  stopReason: number;
}

/**
 * The engine, as the orchestration above needs it.
 *
 * Every method is asynchronous because one implementation of it is: an iOS
 * search runs on a background queue, and the JavaScript thread learns the
 * answer through a promise. The WebAssembly backend is synchronous underneath
 * and simply resolves immediately.
 *
 * The batching in `historySet` and `rootFilter` is not a convenience. On iOS
 * every call is a bridge crossing, and rebuilding a sixty-position history one
 * crossing at a time is the difference between one round trip and sixty.
 */
export interface EngineBackend {
  analyze(
    encoded: EncodedPosition,
    maxDepth: number,
    maxNodes: number,
    maxTimeMs: number,
    variations: number,
  ): Promise<RawAnalysis>;
  /** Replace the repetition history. Resolves to the rejected index, or -1. */
  historySet(history: EncodedPosition[]): Promise<number>;
  /** Extend the repetition history by one. Resolves false if rejected. */
  historyPush(encoded: EncodedPosition): Promise<boolean>;
  /** Restrict the next search's root moves. Resolves to the rejected index, or -1. */
  rootFilter(moves: readonly Move[]): Promise<number>;
  /** Forget the transposition table. */
  searchClear(): Promise<void>;
}

/**
 * Exclusive use of the engine for the duration of one unit of work.
 *
 * The browser needs no such thing: a worker owns its WebAssembly instance
 * outright. iOS does, because the static library's search state is
 * process-global, and an analysis and a review that interleaved their calls
 * would be reading each other's repetition history. The default is therefore
 * a pass-through, and only the native session supplies a real lock.
 */
export type EngineLock = <Result>(unit: () => Promise<Result>) => Promise<Result>;

const withoutLock: EngineLock = (unit) => unit();

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

const now = () => globalThis.performance?.now?.() ?? Date.now();
const wait = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

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

export const encodeEnginePosition = (position: EnginePosition): EncodedPosition => {
  const unavailable = engineUnavailableMessage(position.modeId);
  if (unavailable) throw new Error(unavailable);
  const mode = ENGINE_MODE_CODES[position.modeId];
  const side = COLOR_CODES[position.currentTurn];
  if (mode === undefined || side === undefined) {
    throw new Error('RPSFish does not support this game mode or side.');
  }
  return [mode, side, position.moveNumber, ...encodePosition(position)];
};

// Memoized because a review asks for the same keys repeatedly: every position
// of the walk compares the whole line before it, so an unmemoized key would
// re-encode an eighty-one tile board once per position per step. The positions
// of one request are stable objects, and a weak map lets them be collected
// with the request that held them.
const positionKeys = new WeakMap<EnginePosition, string>();

const enginePositionKey = (position: EnginePosition) => {
  const known = positionKeys.get(position);
  if (known !== undefined) return known;
  const key = encodeEnginePosition(position)
    .map((value) => value.toString())
    .join(':');
  positionKeys.set(position, key);
  return key;
};

const sameKeys = (left: string[] | undefined, right: string[] | undefined) =>
  left !== undefined &&
  right !== undefined &&
  left.length === right.length &&
  left.every((key, index) => key === right[index]);

/** How much of two lines is the same line, counted from the first position. */
const sharedPrefixLength = (left: string[] | undefined, right: string[]) => {
  if (!left) return 0;
  const limit = Math.min(left.length, right.length);
  let shared = 0;
  while (shared < limit && left[shared] === right[shared]) shared += 1;
  return shared;
};

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

const rejected = (count: number) =>
  new Error(count === -2 ? 'RPSFish rejected the board position.' : 'Invalid analysis request.');

const engineLines = (raw: RawAnalysis): EngineLine[] =>
  raw.lines.map((line, index) => ({
    from: squareFromIndex(line.from),
    to: squareFromIndex(line.to),
    score: line.score,
    principalVariation: Array.from(
      { length: Math.floor(line.principalVariation.length / 2) },
      (_unused, ply) => ({
        from: squareFromIndex(line.principalVariation[ply * 2]),
        to: squareFromIndex(line.principalVariation[ply * 2 + 1]),
      }),
    ),
    rank: index + 1,
  }));

const readAnalysis = (
  raw: RawAnalysis,
  position: EnginePosition,
  cumulativeNodes: number,
  started: number,
): Analysis => {
  const elapsedMs = Math.max(1, Math.round(now() - started));
  const stopReason: StopReason = STOP_REASONS[raw.stopReason] ?? 'unknown';

  return {
    confidence: raw.confidence,
    depth: raw.depth,
    elapsedMs,
    lines: engineLines(raw),
    nodes: cumulativeNodes,
    nodesPerSecond: Math.round((cumulativeNodes * 1_000) / elapsedMs),
    redScore: position.currentTurn === 'Red' ? raw.score : -raw.score,
    score: raw.score,
    selectiveDepth: raw.selectiveDepth,
    stopReason,
  };
};

/** Whether the work asking has been abandoned since it started. */
export type Cancelled = () => boolean;

/**
 * One engine, driven correctly.
 *
 * Holds the only mutable state outside the engine itself: what the engine is
 * currently standing on. There is one of these per engine — one per worker in
 * a browser, one per process on iOS — because two of them over one engine
 * would each believe a history the other had replaced.
 */
export const createEngine = (backend: EngineBackend, lock: EngineLock = withoutLock) => {
  // The game line the search table was filled from, and the positions pushed
  // into the repetition history, as engine-position keys. Work that continues
  // the same line keeps both rather than rebuilding them, which is where a
  // review's speed comes from.
  let warmSearchKeys: string[] | undefined;
  let warmHistoryKeys: string[] | undefined;

  /**
   * Make the engine stand where this search needs it, then run it.
   *
   * Called once per search rather than once per request, because on iOS the
   * engine is shared: between two of this session's own calls, another one may
   * have moved it. Standing on a line the engine is already standing on costs
   * nothing, so the check is cheap enough to make every time.
   *
   * The table survives two cases, and they are the two that matter. A search
   * continuing at a position it has already been searching keeps it, which is
   * what makes iterative deepening deepen rather than restart. And a search of
   * a *child* of the last searched position keeps it, because its entries and
   * move ordering are still about this game line. Anything else clears it:
   * repetition-dependent scores cannot move safely between lines.
   */
  const standOn = async (history: EnginePosition[], current: EnginePosition) => {
    const historyKeys = history.map(enginePositionKey);
    const searching = [...historyKeys, enginePositionKey(current)];
    if (!sameKeys(warmSearchKeys, historyKeys) && !sameKeys(warmSearchKeys, searching)) {
      await backend.searchClear();
    }

    // Extended rather than rebuilt when the engine already stands on a prefix
    // of this line. That case is the whole of a review walk — each position's
    // history is the one before it plus one — and it is the difference between
    // linear and quadratic work over a long game.
    const shared = sharedPrefixLength(warmHistoryKeys, historyKeys);
    if (warmHistoryKeys?.length === shared && historyKeys.length > shared) {
      for (let index = shared; index < history.length; index += 1) {
        if (!(await backend.historyPush(encodeEnginePosition(history[index])))) {
          throw new Error('RPSFish rejected a position in the game history.');
        }
      }
    } else if (!sameKeys(warmHistoryKeys, historyKeys)) {
      const rejected = await backend.historySet(history.map(encodeEnginePosition));
      if (rejected >= 0) throw new Error('RPSFish rejected a position in the game history.');
    }

    warmHistoryKeys = historyKeys;
    warmSearchKeys = searching;
  };

  /**
   * One search of one position, with an optional restriction on which root
   * moves it may consider.
   *
   * The whole unit is locked, not just the search: standing the engine on a
   * line and then searching from it are one indivisible act, and a second
   * caller admitted between them would search this position against its own
   * history. The engine spends a root filter on the search it was built for,
   * so an unrestricted search does not have to clear one.
   *
   * `started` is taken inside the lock, immediately before the search, so a
   * reported search time is the search and not the wait for a turn.
   */
  const searchOnce = (
    history: EnginePosition[],
    position: EnginePosition,
    limits: { maxDepth: number; maxNodes: number; maxTimeMs: number; variations: number },
    rootMoves?: Move[],
  ) =>
    lock(async () => {
      await standOn(history, position);
      if (rootMoves) {
        const index = await backend.rootFilter(rootMoves);
        if (index >= 0) throw new Error('RPSFish rejected a move in the review.');
      }
      const started = now();
      const raw = await backend.analyze(
        encodeEnginePosition(position),
        limits.maxDepth,
        limits.maxNodes,
        limits.maxTimeMs,
        limits.variations,
      );
      if (raw.count < 0) throw rejected(raw.count);
      return { raw, started };
    });

  const analyze = async (
    position: AnalyzePositionRequest,
    rawOptions: Partial<SearchLimits> | undefined,
    onUpdate: (analysis: Analysis) => void,
    cancelled: Cancelled,
  ): Promise<Analysis | undefined> => {
    const options = normalizeOptions(rawOptions);
    const history = position.history ?? [];
    const started = now();
    let cumulativeNodes = 0;
    let lastCompletedDepth = -1;
    let latest: Analysis | undefined;

    for (let targetDepth = 1; targetDepth <= options.maxDepth; targetDepth += 1) {
      if (cancelled()) return undefined;

      const remainingNodes = options.maxNodes - cumulativeNodes;
      const remainingTimeMs = options.maxTimeMs - Math.round(now() - started);
      // The first depth is always searched; every later one is asked for only
      // if there is budget left for it. Without that floor a request that
      // spent its whole allowance waiting for the engine — possible on iOS,
      // where one engine serves every screen — would resolve to nothing at
      // all, and a caller waiting on an answer would sit until its deadline.
      if (targetDepth > 1 && (remainingNodes <= 0 || remainingTimeMs <= 0)) break;

      const { raw } = await searchOnce(history, position, {
        maxDepth: targetDepth,
        maxNodes: Math.max(1, remainingNodes),
        maxTimeMs: Math.max(1, remainingTimeMs),
        variations: options.variations,
      });
      if (cancelled()) return undefined;

      cumulativeNodes += raw.nodes;
      latest = readAnalysis(raw, position, cumulativeNodes, started);
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

      // Yield between depths so a new position can cancel this request, so
      // deep analysis does not monopolize the event loop, and — on iOS, where
      // one engine serves everything — so a review can take a turn.
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
    data: ReviewRequest,
    onEntry: (entry: ReviewEntry, total: number) => void,
    cancelled: Cancelled,
  ): Promise<ReviewEntry[] | undefined> => {
    const options = normalizeOptions(data.options, REVIEW_CAPS);
    const positions = data.positions ?? [];
    const moves = data.moves ?? [];
    const from = boundedInteger(data.analyzeFrom, 0, 0, positions.length);
    const entries: ReviewEntry[] = [];

    for (let index = from; index < positions.length; index += 1) {
      if (cancelled()) return undefined;
      const position = positions[index];
      if (!position) break;
      const history = positions.slice(0, index);
      const searchLimits = {
        maxDepth: options.maxDepth,
        maxNodes: options.maxNodes,
        maxTimeMs: options.maxTimeMs,
        variations: options.variations,
      };
      const { raw, started } = await searchOnce(history, position, searchLimits);
      const analysis = readAnalysis(raw, position, raw.nodes, started);
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
          const pairedSearch = await searchOnce(
            history,
            position,
            { ...searchLimits, variations: 2 },
            [{ from: best.from, to: best.to }, played],
          );
          const paired = readAnalysis(
            pairedSearch.raw,
            position,
            pairedSearch.raw.nodes,
            pairedSearch.started,
          );
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
      // Yield so a cancelled review stops promptly, the caller stays
      // answerable while a long game is graded, and an interactive search
      // sharing this engine can take a turn between positions.
      //
      // Nothing is pushed into the repetition history here on purpose. This
      // position belongs in the history of the *next* one, and the next step
      // puts it there under the lock — where a caller admitted during this
      // yield cannot have replaced the history underneath it.
      await wait(options.throttleMs);
    }
    return entries;
  };

  return { analyze, review };
};

export type RPSFishEngine = ReturnType<typeof createEngine>;

/**
 * The request/response loop, once.
 *
 * Written against `postMessage` because that is the browser worker's only way
 * to answer, and the native session is cheaply shaped to match — which is what
 * lets `client.ts` hold a single lane implementation for both. One host tracks
 * one active request: a new request supersedes the one before it, which is the
 * behaviour the interactive lane wants. Two kinds of work that must not
 * supersede each other are given a host each.
 */
export const createSessionHost = (
  engine: RPSFishEngine,
  postMessage: (message: WorkerResponse) => void,
) => {
  let activeRequestId: number | undefined;

  const handleMessage = async (data: WorkerRequest | undefined) => {
    if (data?.type === 'cancel') {
      if (activeRequestId === data.requestId) activeRequestId = undefined;
      return;
    }
    if (data?.type !== 'analyze' && data?.type !== 'review') return;

    const previousRequestId = activeRequestId;
    if (previousRequestId !== undefined && previousRequestId !== data.requestId) {
      postMessage({ type: 'cancelled', requestId: previousRequestId });
    }
    activeRequestId = data.requestId;
    const cancelled = () => activeRequestId !== data.requestId;

    if (data.type === 'review') {
      try {
        const entries = await engine.review(
          data,
          (entry, total) => {
            if (!cancelled()) {
              postMessage({ type: 'review-progress', requestId: data.requestId, entry, total });
            }
          },
          cancelled,
        );
        if (!cancelled() && entries) {
          postMessage({ type: 'review', requestId: data.requestId, entries });
          activeRequestId = undefined;
        }
      } catch (error) {
        if (!cancelled()) {
          postMessage({
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
      const analysis = await engine.analyze(
        data.position,
        data.options,
        (update) => {
          if (!cancelled()) {
            postMessage({ type: 'analysis-update', requestId: data.requestId, analysis: update });
          }
        },
        cancelled,
      );
      if (!cancelled() && analysis) {
        postMessage({ type: 'analysis', requestId: data.requestId, analysis });
        activeRequestId = undefined;
      }
    } catch (error) {
      if (!cancelled()) {
        postMessage({
          type: 'error',
          requestId: data.requestId,
          message: failureMessage(error, 'RPSFish analysis failed.'),
        });
        activeRequestId = undefined;
      }
    }
  };

  /** Abandon whatever is running, without answering for it. */
  const cancelAll = () => {
    activeRequestId = undefined;
  };

  return { cancelAll, handleMessage };
};
