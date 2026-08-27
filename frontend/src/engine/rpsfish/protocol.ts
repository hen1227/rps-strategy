// The contract between the page and the RPSFish worker.
//
// Both ends import this file, which is the point: the worker is bundled from
// TypeScript into `public/rpsfish/rpsfish-worker.js`, so the message shapes it
// posts and the shapes the client reads are checked against one definition
// instead of being kept in step by hand. A field added to an entry here is a
// field both ends see immediately.

import type { EnginePosition } from '../analysisGame';
import type { Move, Position } from '@/types/game';

/** Why a search stopped. Anything the engine reports outside this set reads as `unknown`. */
export type StopReason =
  | 'depth'
  | 'nodes'
  | 'time'
  | 'cancelled'
  | 'terminal'
  | 'repetition'
  | 'no-legal-move'
  | 'unknown';

export const STOP_REASONS: readonly StopReason[] = [
  'depth',
  'nodes',
  'time',
  'cancelled',
  'terminal',
  'repetition',
  'no-legal-move',
];

/** What a caller may ask of one search. The worker clamps every field. */
export interface SearchLimits {
  maxDepth: number;
  maxNodes: number;
  maxTimeMs: number;
  throttleMs: number;
  variations: number;
}

/** The ceilings the worker clamps a request to. */
export interface EngineCaps {
  maxDepth: number;
  maxNodes: number;
  maxTimeMs: number;
  maxVariations: number;
  maxThrottleMs: number;
}

/** One ranked continuation from a searched position. */
export interface EngineLine extends Move {
  score: number;
  principalVariation: Move[];
  /** 1 for the engine's own choice. */
  rank: number;
}

/** Everything one completed search says about one position. */
export interface Analysis {
  confidence: number;
  depth: number;
  elapsedMs: number;
  lines: EngineLine[];
  nodes: number;
  nodesPerSecond: number;
  /**
   * `score` from Red's point of view, so a chart can plot a whole game without
   * flipping sign every ply.
   */
  redScore: number;
  /** Positive is good for the side to move. */
  score: number;
  selectiveDepth: number;
  stopReason: StopReason;
}

/**
 * One position of a game, searched, with the move actually played out of it.
 *
 * `baselineScore` is what `playedScore` is measured against, and both come
 * from the same search — see the paired search in the worker's `review`.
 * `played` is `null` for the final position of a finished game, which has an
 * evaluation but no move to grade.
 */
export interface ReviewEntry {
  index: number;
  analysis: Analysis;
  baselineScore: number | null;
  played: Move | null;
  playedScore: number | null;
  playedVariation: Move[] | null;
}

/** A position to search, optionally with the line that led to it. */
export interface AnalyzePositionRequest extends EnginePosition {
  /** Earlier positions of the same game, for repetition detection. */
  history?: EnginePosition[];
}

/* ------------------------------------------------------------- messages -- */

export interface AnalyzeRequest {
  type: 'analyze';
  requestId: number;
  position: AnalyzePositionRequest;
  options: Partial<SearchLimits>;
}

export interface ReviewRequest {
  type: 'review';
  requestId: number;
  positions: EnginePosition[];
  moves: Move[];
  /** The first position to search. Earlier ones are replayed for repetition only. */
  analyzeFrom: number;
  options: Partial<SearchLimits>;
}

export interface CancelRequest {
  type: 'cancel';
  requestId: number;
}

export type WorkerRequest = AnalyzeRequest | ReviewRequest | CancelRequest;

/**
 * A request before its id is stamped on.
 *
 * Spelled out per variant rather than as `Omit<WorkerRequest, 'requestId'>`,
 * because `Omit` over a union collapses it into one object type with the
 * intersection of its keys — and then no variant's own fields are assignable.
 */
export type WorkerRequestBody =
  | Omit<AnalyzeRequest, 'requestId'>
  | Omit<ReviewRequest, 'requestId'>
  | Omit<CancelRequest, 'requestId'>;

export type WorkerResponse =
  | { type: 'analysis-update'; requestId: number; analysis: Analysis }
  | { type: 'analysis'; requestId: number; analysis: Analysis }
  | { type: 'review-progress'; requestId: number; entry: ReviewEntry; total: number }
  | { type: 'review'; requestId: number; entries: ReviewEntry[] }
  | { type: 'cancelled'; requestId: number }
  | { type: 'error'; requestId: number; message: string };

/**
 * Whatever is running the engine, as the lane in `client.ts` needs it.
 *
 * Named for the browser worker it was first written against, and kept to
 * exactly the members that worker is used for, because the second
 * implementation is not a worker at all: on iOS the engine runs in this
 * process behind `nativeSession.ts`, which presents this same shape. A lane
 * cannot tell them apart, which is the point — the queueing, timeouts and
 * cancellation are written once.
 */
export interface EngineWorker {
  onmessage: ((event: { data: WorkerResponse }) => void) | null;
  onerror: ((event: { message?: string }) => void) | null;
  onmessageerror: (() => void) | null;
  postMessage: (message: WorkerRequest) => void;
  terminate: () => void;
}

/** The board coordinate of a square index, as the engine numbers them. */
export const squareFromIndex = (index: number): Position => ({
  x: index % 9,
  y: Math.floor(index / 9),
});

export const squareIndex = ({ x, y }: Position) => y * 9 + x;
