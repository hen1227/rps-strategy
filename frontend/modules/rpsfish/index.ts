// The RPSFish native module, as TypeScript.
//
// One declaration per function `ios/RPSFishEngineModule.swift` defines, so a
// signature that drifts from the Swift is a compile error here rather than a
// wrong number on screen. The ABI version is checked at load for the same
// reason — see `src/engine/rpsfish/nativeSession.ts`.

import { requireOptionalNativeModule } from 'expo';

/** One ranked continuation, with squares as the ABI's indices. */
export interface NativeLine {
  from: number;
  to: number;
  score: number;
  /** The principal variation as a flat run of `from, to` square indices. */
  principalVariation: number[];
}

/** One completed search, read straight off the ABI. */
export interface NativeAnalysis {
  /** What `rpsfish_analyze` returned. Negative is a rejection. */
  count: number;
  confidence: number;
  depth: number;
  lines: NativeLine[];
  nodes: number;
  score: number;
  selectiveDepth: number;
  stopReason: number;
}

export interface RPSFishNativeModule {
  /** The ABI the installed library implements. */
  abiVersion: number;
  /** The ABI the Swift module was written against. */
  requiredAbiVersion: number;
  rulesVersion: number;

  /**
   * Search one position.
   *
   * `position` is thirty-five numbers: mode, side and move number, then the
   * eight bitboards as thirty-two 32-bit chunks, low chunk first. Doubles
   * cannot hold a 64-bit word exactly, which is why the halves are split.
   */
  analyze(
    position: number[],
    maxDepth: number,
    maxNodes: number,
    maxTimeMs: number,
    variations: number,
  ): Promise<NativeAnalysis>;

  /** Replace the repetition history. Resolves to the rejected index, or -1. */
  historySet(positions: number[][]): Promise<number>;

  /** Extend the repetition history by one position. */
  historyPush(position: number[]): Promise<boolean>;

  /**
   * Restrict the next search's root moves, as a flat run of `from, to` square
   * indices. Resolves to the rejected move's index, or -1.
   */
  rootFilter(squares: number[]): Promise<number>;

  /** Forget the transposition table. */
  searchClear(): Promise<void>;
}

/**
 * Optional on purpose.
 *
 * The engine ships in the native binary, so a JavaScript bundle can outlive
 * the build that had it — a development client without the module, or a
 * platform it was never built for. `null` there lets the caller say so
 * plainly instead of throwing on import and taking the whole app with it.
 */
export default requireOptionalNativeModule<RPSFishNativeModule>('RPSFishEngine');
