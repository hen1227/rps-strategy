// Copyright (C) 2026 Henry Abrahamsen
// SPDX-License-Identifier: LGPL-3.0-or-later
//
// The RPSFish C ABI, as a native module.
//
// This file is the iOS counterpart of the browser's worker: it loads nothing,
// decides nothing, and holds no opinion about search. Every decision about
// which ABI calls to make, and in what order, is in
// `src/engine/rpsfish/session.ts`, which the web build runs too. What is here
// is the part that cannot be shared — moving arguments across the bridge, and
// keeping the engine off the threads that must stay responsive.

import ExpoModulesCore
import RPSFish

/// The number of values in one encoded position: mode, side and move number,
/// then the eight bitboards as thirty-two 32-bit chunks.
private let positionValueCount = 35

/// The ABI this module is written against. Checked once, at load.
private let requiredAbiVersion: Int32 = 4

private struct DecodedPosition {
  let mode: Int32
  let side: Int32
  let ply: Int32
  /// The eight 128-bit bitboards as sixteen 64-bit words, low word first.
  let words: [UInt64]
}

private final class RPSFishError: Exception {
  private let detail: String

  init(_ detail: String) {
    self.detail = detail
    super.init()
  }

  override var reason: String { detail }
}

/// JavaScript numbers are doubles, and a bitboard word is not exactly
/// representable as one: a 9x9 board fills bits past the 53 a double can hold.
/// Every word therefore crosses as two 32-bit halves and is put back together
/// here, which is exact for every value the encoder can produce.
private func decodePosition(_ raw: [Double]) throws -> DecodedPosition {
  guard raw.count == positionValueCount else {
    throw RPSFishError("RPSFish was given \(raw.count) position values, not \(positionValueCount).")
  }

  func chunk(_ index: Int) throws -> UInt64 {
    guard let value = UInt32(exactly: raw[index].rounded()) else {
      throw RPSFishError("RPSFish was given a board word that is not a 32-bit value.")
    }
    return UInt64(value)
  }

  var words: [UInt64] = []
  words.reserveCapacity(16)
  for word in 0..<16 {
    let low = try chunk(3 + word * 2)
    let high = try chunk(4 + word * 2)
    words.append(low | (high << 32))
  }

  return DecodedPosition(
    mode: Int32(raw[0]),
    side: Int32(raw[1]),
    ply: Int32(raw[2]),
    words: words
  )
}

private func analysisReading(count: Int32) -> [String: Any] {
  guard count >= 0 else {
    return [
      "count": Int(count),
      "confidence": 0,
      "depth": 0,
      "lines": [[String: Any]](),
      "nodes": 0,
      "score": 0,
      "selectiveDepth": 0,
      "stopReason": 0,
    ]
  }

  var lines: [[String: Any]] = []
  let lineCount = rpsfish_analysis_count()
  lines.reserveCapacity(Int(max(0, lineCount)))
  for index in 0..<max(0, lineCount) {
    let plies = rpsfish_analysis_pv_length(index)
    // Flat `from, to` pairs: one array of numbers is the cheapest thing to
    // hand the bridge, and the shared session reads the same shape from the
    // browser worker.
    var principalVariation: [Int] = []
    principalVariation.reserveCapacity(Int(max(0, plies)) * 2)
    for ply in 0..<max(0, plies) {
      principalVariation.append(Int(rpsfish_analysis_pv_from(index, ply)))
      principalVariation.append(Int(rpsfish_analysis_pv_to(index, ply)))
    }
    lines.append([
      "from": Int(rpsfish_analysis_from(index)),
      "to": Int(rpsfish_analysis_to(index)),
      "score": Int(rpsfish_analysis_line_score(index)),
      "principalVariation": principalVariation,
    ])
  }

  return [
    "count": Int(count),
    "confidence": Int(rpsfish_analysis_confidence()),
    "depth": Int(rpsfish_analysis_depth()),
    "lines": lines,
    "nodes": Int(rpsfish_analysis_nodes()),
    "score": Int(rpsfish_analysis_score()),
    "selectiveDepth": Int(rpsfish_analysis_selective_depth()),
    "stopReason": Int(rpsfish_analysis_stop_reason().rawValue),
  ]
}

public final class RPSFishEngineModule: Module {
  // One serial queue for everything.
  //
  // Two reasons, and either alone would be enough. A search is synchronous and
  // can run for seconds, so it must never be on a thread anybody is waiting
  // on — not the UI thread, and not the JavaScript thread. And the engine's
  // search state is process-global: the repetition history and the root filter
  // belong to whichever search is being set up right now, so two searches
  // being set up at once would each read the other's. Serialising every call
  // makes each one indivisible with respect to the others.
  //
  // `userInitiated` rather than `background`: somebody is looking at a
  // spinner. Analysis that took eight times as long to keep a phone cool
  // would be the wrong trade for a move the player is waiting on.
  private static let queue = DispatchQueue(
    label: "com.henhen1227.rpsfish.engine",
    qos: .userInitiated
  )

  public func definition() -> ModuleDefinition {
    Name("RPSFishEngine")

    Constants([
      "abiVersion": Int(rpsfish_abi_version()),
      "requiredAbiVersion": Int(requiredAbiVersion),
      "rulesVersion": Int(rpsfish_rules_version()),
    ])

    AsyncFunction("analyze") {
      (
        position: [Double],
        maxDepth: Int,
        maxNodes: Int,
        maxTimeMs: Int,
        variations: Int
      ) -> [String: Any] in
      let decoded = try decodePosition(position)
      let words = decoded.words
      let count = rpsfish_analyze(
        decoded.mode,
        decoded.side,
        decoded.ply,
        words[0], words[1],
        words[2], words[3],
        words[4], words[5],
        words[6], words[7],
        words[8], words[9],
        words[10], words[11],
        words[12], words[13],
        words[14], words[15],
        Int32(clamping: maxDepth),
        Int32(clamping: maxNodes),
        Int32(clamping: maxTimeMs),
        Int32(clamping: variations)
      )
      return analysisReading(count: count)
    }.runOnQueue(Self.queue)

    // Replace the repetition history in one crossing. Returns the index of the
    // first position the engine refused, or -1.
    AsyncFunction("historySet") { (positions: [[Double]]) -> Int in
      rpsfish_history_clear()
      for (index, raw) in positions.enumerated() {
        let decoded = try decodePosition(raw)
        let words = decoded.words
        let pushed = rpsfish_history_push(
          decoded.mode,
          decoded.side,
          decoded.ply,
          words[0], words[1],
          words[2], words[3],
          words[4], words[5],
          words[6], words[7],
          words[8], words[9],
          words[10], words[11],
          words[12], words[13],
          words[14], words[15]
        )
        if pushed < 0 {
          return index
        }
      }
      return -1
    }.runOnQueue(Self.queue)

    AsyncFunction("historyPush") { (position: [Double]) -> Bool in
      let decoded = try decodePosition(position)
      let words = decoded.words
      return rpsfish_history_push(
        decoded.mode,
        decoded.side,
        decoded.ply,
        words[0], words[1],
        words[2], words[3],
        words[4], words[5],
        words[6], words[7],
        words[8], words[9],
        words[10], words[11],
        words[12], words[13],
        words[14], words[15]
      ) >= 0
    }.runOnQueue(Self.queue)

    // Restrict the next search's root moves. Returns the index of the first
    // move the engine refused, or -1. Squares are indices, as the ABI numbers
    // them; the engine spends the filter on the search it was built for.
    AsyncFunction("rootFilter") { (squares: [Int]) -> Int in
      rpsfish_root_filter_clear()
      var move = 0
      while move * 2 + 1 < squares.count {
        let from = Int32(clamping: squares[move * 2])
        let to = Int32(clamping: squares[move * 2 + 1])
        if rpsfish_root_filter_push(from, to) < 0 {
          return move
        }
        move += 1
      }
      return -1
    }.runOnQueue(Self.queue)

    AsyncFunction("searchClear") {
      rpsfish_search_clear()
    }.runOnQueue(Self.queue)
  }
}
