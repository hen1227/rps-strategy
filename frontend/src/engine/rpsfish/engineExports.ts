// The RPSFish WASM ABI, as TypeScript.
//
// One declaration per export the worker calls, so a signature that drifts from
// `RPSFish/src/wasm.rs` is a compile error here rather than a wrong number on
// screen. `rpsfish_abi_version` is checked at load time for the same reason,
// and the two must be bumped together.

/**
 * A value crossing the WASM boundary.
 *
 * `bigint` is not decoration: the bitboards are `i64` parameters, and passing a
 * `number` where the engine declares an `i64` is a TypeError at the call, not a
 * silent conversion. Positions are encoded once, by
 * `worker/index.ts:encodeEnginePosition`, and every argument list below is
 * built from that.
 */
export type EngineWord = number | bigint;

/**
 * The engine's encoding of a position.
 *
 * Nineteen values: mode, side and move number as `i32`, then the eight
 * bitboards as sixteen `i64` halves, low word first.
 */
export type EncodedPosition = EngineWord[];

export interface RPSFishExports {
  rpsfish_abi_version: () => number;

  /**
   * Search one position and store the result for the readers below.
   *
   * Returns the number of lines produced, or a negative code: -2 for a board
   * the engine rejected, anything else for a malformed request.
   */
  /** Called as `rpsfish_analyze(...encodedPosition, maxDepth, maxNodes, maxTimeMs, variations)`. */
  rpsfish_analyze: (...args: EngineWord[]) => number;

  rpsfish_analysis_count: () => number;
  rpsfish_analysis_score: () => number;
  rpsfish_analysis_depth: () => number;
  rpsfish_analysis_selective_depth: () => number;
  rpsfish_analysis_confidence: () => number;
  rpsfish_analysis_nodes: () => number;
  rpsfish_analysis_stop_reason: () => number;

  rpsfish_analysis_from: (lineIndex: number) => number;
  rpsfish_analysis_to: (lineIndex: number) => number;
  rpsfish_analysis_line_score: (lineIndex: number) => number;

  rpsfish_analysis_pv_length: (lineIndex: number) => number;
  rpsfish_analysis_pv_from: (lineIndex: number, ply: number) => number;
  rpsfish_analysis_pv_to: (lineIndex: number, ply: number) => number;

  /** Forget the transposition table. Required whenever the game line changes. */
  rpsfish_search_clear: () => void;

  rpsfish_history_clear: () => void;
  /** Push one position onto the repetition history. Negative on rejection. */
  rpsfish_history_push: (...encoded: EncodedPosition) => number;

  /** Restrict the next search's root moves. Empty means every legal move. */
  rpsfish_root_filter_clear: () => void;
  rpsfish_root_filter_push: (fromIndex: number, toIndex: number) => number;
}

/** The ABI this worker is written against. */
export const REQUIRED_ABI_VERSION = 4;
