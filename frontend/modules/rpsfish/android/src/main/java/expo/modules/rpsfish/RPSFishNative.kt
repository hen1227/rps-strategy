// Copyright (C) 2026 Henhen1227, LLC
// SPDX-License-Identifier: LGPL-3.0-or-later

package expo.modules.rpsfish

/**
 * The RPSFish C ABI, as `src/main/cpp/rpsfish_jni.c` exposes it: one function
 * per C function, with each position's eight bitboards as sixteen longs.
 *
 * The engine's state is process-global. Call these only from the engine's own
 * thread in `RPSFishEngineModule`.
 */
internal object RPSFishNative {
  init {
    System.loadLibrary("rpsfish_jni")
  }

  @JvmStatic external fun abiVersion(): Int
  @JvmStatic external fun rulesVersion(): Int

  @JvmStatic external fun analyze(
    mode: Int,
    side: Int,
    ply: Int,
    words: LongArray,
    maxDepth: Int,
    maxNodes: Int,
    maxTimeMs: Int,
    variations: Int,
  ): Int

  @JvmStatic external fun searchClear()
  @JvmStatic external fun historyClear()
  @JvmStatic external fun historyPush(mode: Int, side: Int, ply: Int, words: LongArray): Int
  @JvmStatic external fun rootFilterClear()
  @JvmStatic external fun rootFilterPush(from: Int, to: Int): Int

  @JvmStatic external fun analysisCount(): Int
  @JvmStatic external fun analysisScore(): Int
  @JvmStatic external fun analysisDepth(): Int
  @JvmStatic external fun analysisSelectiveDepth(): Int
  @JvmStatic external fun analysisConfidence(): Int
  @JvmStatic external fun analysisNodes(): Int
  @JvmStatic external fun analysisStopReason(): Int

  @JvmStatic external fun analysisFrom(line: Int): Int
  @JvmStatic external fun analysisTo(line: Int): Int
  @JvmStatic external fun analysisLineScore(line: Int): Int
  @JvmStatic external fun analysisPvLength(line: Int): Int
  @JvmStatic external fun analysisPvFrom(line: Int, ply: Int): Int
  @JvmStatic external fun analysisPvTo(line: Int, ply: Int): Int
}
