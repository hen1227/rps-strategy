// Copyright (C) 2026 Henhen1227, LLC
// SPDX-License-Identifier: LGPL-3.0-or-later
//
// The RPSFish C ABI, as a native module.
//
// The Android counterpart of `ios/RPSFishEngineModule.swift`, and it does the
// same five things the same way: it loads nothing, decides nothing, and holds
// no opinion about search. Every decision about which ABI calls to make, and in
// what order, is in `src/engine/rpsfish/session.ts`, which every platform runs.
// What is here is the part that cannot be shared — moving arguments across the
// bridge, and keeping the engine off the threads that must stay responsive.

package expo.modules.rpsfish

import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.util.concurrent.Executors
import kotlin.math.max
import kotlin.math.round
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.asCoroutineDispatcher

/** Mode, side and move number, then the eight bitboards as 32 32-bit chunks. */
private const val POSITION_VALUE_COUNT = 35

/** The ABI this module is written against. Checked once, by the JavaScript. */
private const val REQUIRED_ABI_VERSION = 4

private class RPSFishException(message: String) : CodedException(message)

private class DecodedPosition(
  val mode: Int,
  val side: Int,
  val ply: Int,
  /** The eight 128-bit bitboards as sixteen 64-bit words, low word first. */
  val words: LongArray,
)

/**
 * JavaScript numbers are doubles, and a bitboard word is not exactly
 * representable as one: a 9x9 board fills bits past the 53 a double can hold.
 * Every word therefore crosses as two 32-bit halves and is put back together
 * here, which is exact for every value the encoder can produce.
 */
private fun decodePosition(raw: List<Double>): DecodedPosition {
  if (raw.size != POSITION_VALUE_COUNT) {
    throw RPSFishException("RPSFish was given ${raw.size} position values, not $POSITION_VALUE_COUNT.")
  }
  fun chunk(index: Int): Long {
    val value = round(raw[index])
    if (value < 0.0 || value > 4294967295.0) {
      throw RPSFishException("RPSFish was given a board word that is not a 32-bit value.")
    }
    return value.toLong()
  }
  val words = LongArray(16) { word -> chunk(3 + word * 2) or (chunk(4 + word * 2) shl 32) }
  return DecodedPosition(raw[0].toInt(), raw[1].toInt(), raw[2].toInt(), words)
}

/** A JavaScript number as the ABI's `int32_t`, saturating as Swift's `clamping:` does. */
private fun clamped(value: Double): Int =
  if (value.isNaN()) 0 else value.coerceIn(Int.MIN_VALUE.toDouble(), Int.MAX_VALUE.toDouble()).toInt()

private fun analysisReading(count: Int): Map<String, Any> {
  if (count < 0) {
    return mapOf(
      "count" to count,
      "confidence" to 0,
      "depth" to 0,
      "lines" to emptyList<Map<String, Any>>(),
      "nodes" to 0,
      "score" to 0,
      "selectiveDepth" to 0,
      "stopReason" to 0,
    )
  }

  val lineCount = max(0, RPSFishNative.analysisCount())
  val lines = List(lineCount) { index ->
    val plies = max(0, RPSFishNative.analysisPvLength(index))
    // Flat `from, to` pairs: one array of numbers is the cheapest thing to
    // hand the bridge, and the shared session reads the same shape from the
    // browser worker.
    val principalVariation = IntArray(plies * 2)
    for (ply in 0 until plies) {
      principalVariation[ply * 2] = RPSFishNative.analysisPvFrom(index, ply)
      principalVariation[ply * 2 + 1] = RPSFishNative.analysisPvTo(index, ply)
    }
    mapOf(
      "from" to RPSFishNative.analysisFrom(index),
      "to" to RPSFishNative.analysisTo(index),
      "score" to RPSFishNative.analysisLineScore(index),
      "principalVariation" to principalVariation.toList(),
    )
  }

  return mapOf(
    "count" to count,
    "confidence" to RPSFishNative.analysisConfidence(),
    "depth" to RPSFishNative.analysisDepth(),
    "lines" to lines,
    "nodes" to RPSFishNative.analysisNodes(),
    "score" to RPSFishNative.analysisScore(),
    "selectiveDepth" to RPSFishNative.analysisSelectiveDepth(),
    "stopReason" to RPSFishNative.analysisStopReason(),
  )
}

private fun pushHistory(position: DecodedPosition): Int =
  RPSFishNative.historyPush(position.mode, position.side, position.ply, position.words)

class RPSFishEngineModule : Module() {
  companion object {
    // One thread for everything, as the Swift module has one serial queue.
    //
    // Two reasons, and either alone would be enough. A search is synchronous
    // and can run for seconds, so it must never be on a thread anybody is
    // waiting on — and Expo's default queue for async functions is one thread
    // shared by every module in the app, so a search there would stall all of
    // them. And the engine's search state is process-global: the repetition
    // history and the root filter belong to whichever search is being set up
    // right now, so calls must run one at a time and in the order they were
    // made, which a single-thread executor guarantees.
    private val engine = CoroutineScope(
      Executors.newSingleThreadExecutor { work -> Thread(work, "com.henhen1227.rpsfish.engine") }
        .asCoroutineDispatcher() + SupervisorJob()
    )
  }

  override fun definition() = ModuleDefinition {
    Name("RPSFishEngine")

    Constant("abiVersion") { RPSFishNative.abiVersion() }
    Constant("requiredAbiVersion") { REQUIRED_ABI_VERSION }
    Constant("rulesVersion") { RPSFishNative.rulesVersion() }

    AsyncFunction("analyze") {
      position: List<Double>, maxDepth: Double, maxNodes: Double, maxTimeMs: Double, variations: Double ->
      val decoded = decodePosition(position)
      val count = RPSFishNative.analyze(
        decoded.mode,
        decoded.side,
        decoded.ply,
        decoded.words,
        clamped(maxDepth),
        clamped(maxNodes),
        clamped(maxTimeMs),
        clamped(variations),
      )
      analysisReading(count)
    }.runOnQueue(engine)

    // Replace the repetition history in one crossing. Returns the index of the
    // first position the engine refused, or -1.
    AsyncFunction("historySet") { positions: List<List<Double>> ->
      RPSFishNative.historyClear()
      for ((index, raw) in positions.withIndex()) {
        if (pushHistory(decodePosition(raw)) < 0) return@AsyncFunction index
      }
      -1
    }.runOnQueue(engine)

    AsyncFunction("historyPush") { position: List<Double> ->
      pushHistory(decodePosition(position)) >= 0
    }.runOnQueue(engine)

    // Restrict the next search's root moves. Returns the index of the first
    // move the engine refused, or -1. Squares are indices, as the ABI numbers
    // them; the engine spends the filter on the search it was built for.
    AsyncFunction("rootFilter") { squares: List<Double> ->
      RPSFishNative.rootFilterClear()
      var move = 0
      while (move * 2 + 1 < squares.size) {
        if (RPSFishNative.rootFilterPush(clamped(squares[move * 2]), clamped(squares[move * 2 + 1])) < 0) {
          return@AsyncFunction move
        }
        move += 1
      }
      -1
    }.runOnQueue(engine)

    AsyncFunction("searchClear") {
      RPSFishNative.searchClear()
    }.runOnQueue(engine)
  }
}
