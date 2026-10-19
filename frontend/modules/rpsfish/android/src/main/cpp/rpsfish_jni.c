// Copyright (C) 2026 Henhen1227, LLC
// SPDX-License-Identifier: LGPL-3.0-or-later
//
// The RPSFish C ABI, one JNI function per C function.
//
// Nothing is decided here. `RPSFishNative.kt` declares these and
// `RPSFishEngineModule.kt` calls them, on the one thread the engine's
// process-global state is allowed to be touched from.
//
// The eight 128-bit bitboards cross as sixteen Java longs, low word first. A
// long is signed and a word is not, but the bits are the same, so the cast
// below is exact for every value.

#include <jni.h>
#include <stdint.h>

#include "RPSFish.h"

#define RPSFISH_WORDS 16

#define RPSFISH_JNI(name) Java_expo_modules_rpsfish_RPSFishNative_##name

// Copies a position's words out of Java. Returns 0 if the array is the wrong
// length, which the caller reports as an invalid position.
static int read_words(JNIEnv *env, jlongArray array, uint64_t words[RPSFISH_WORDS]) {
  if (array == NULL || (*env)->GetArrayLength(env, array) != RPSFISH_WORDS) return 0;
  jlong raw[RPSFISH_WORDS];
  (*env)->GetLongArrayRegion(env, array, 0, RPSFISH_WORDS, raw);
  for (int i = 0; i < RPSFISH_WORDS; i++) words[i] = (uint64_t)raw[i];
  return 1;
}

JNIEXPORT jint JNICALL RPSFISH_JNI(abiVersion)(JNIEnv *env, jclass cls) {
  return rpsfish_abi_version();
}

JNIEXPORT jint JNICALL RPSFISH_JNI(rulesVersion)(JNIEnv *env, jclass cls) {
  return rpsfish_rules_version();
}

JNIEXPORT jint JNICALL RPSFISH_JNI(analyze)(
    JNIEnv *env, jclass cls, jint mode, jint side, jint ply, jlongArray array,
    jint max_depth, jint max_nodes, jint max_time_ms, jint variations) {
  uint64_t w[RPSFISH_WORDS];
  if (!read_words(env, array, w)) return RPSFISH_ERROR_INVALID_POSITION;
  return rpsfish_analyze(
      mode, side, ply,
      w[0], w[1], w[2], w[3], w[4], w[5], w[6], w[7],
      w[8], w[9], w[10], w[11], w[12], w[13], w[14], w[15],
      max_depth, max_nodes, max_time_ms, variations);
}

JNIEXPORT void JNICALL RPSFISH_JNI(searchClear)(JNIEnv *env, jclass cls) {
  rpsfish_search_clear();
}

JNIEXPORT void JNICALL RPSFISH_JNI(historyClear)(JNIEnv *env, jclass cls) {
  rpsfish_history_clear();
}

JNIEXPORT jint JNICALL RPSFISH_JNI(historyPush)(
    JNIEnv *env, jclass cls, jint mode, jint side, jint ply, jlongArray array) {
  uint64_t w[RPSFISH_WORDS];
  if (!read_words(env, array, w)) return RPSFISH_ERROR_INVALID_POSITION;
  return rpsfish_history_push(
      mode, side, ply,
      w[0], w[1], w[2], w[3], w[4], w[5], w[6], w[7],
      w[8], w[9], w[10], w[11], w[12], w[13], w[14], w[15]);
}

JNIEXPORT void JNICALL RPSFISH_JNI(rootFilterClear)(JNIEnv *env, jclass cls) {
  rpsfish_root_filter_clear();
}

JNIEXPORT jint JNICALL RPSFISH_JNI(rootFilterPush)(JNIEnv *env, jclass cls, jint from, jint to) {
  return rpsfish_root_filter_push(from, to);
}

JNIEXPORT jint JNICALL RPSFISH_JNI(analysisCount)(JNIEnv *env, jclass cls) {
  return rpsfish_analysis_count();
}

JNIEXPORT jint JNICALL RPSFISH_JNI(analysisScore)(JNIEnv *env, jclass cls) {
  return rpsfish_analysis_score();
}

JNIEXPORT jint JNICALL RPSFISH_JNI(analysisDepth)(JNIEnv *env, jclass cls) {
  return rpsfish_analysis_depth();
}

JNIEXPORT jint JNICALL RPSFISH_JNI(analysisSelectiveDepth)(JNIEnv *env, jclass cls) {
  return rpsfish_analysis_selective_depth();
}

JNIEXPORT jint JNICALL RPSFISH_JNI(analysisConfidence)(JNIEnv *env, jclass cls) {
  return rpsfish_analysis_confidence();
}

JNIEXPORT jint JNICALL RPSFISH_JNI(analysisNodes)(JNIEnv *env, jclass cls) {
  return rpsfish_analysis_nodes();
}

JNIEXPORT jint JNICALL RPSFISH_JNI(analysisStopReason)(JNIEnv *env, jclass cls) {
  return (jint)rpsfish_analysis_stop_reason();
}

JNIEXPORT jint JNICALL RPSFISH_JNI(analysisFrom)(JNIEnv *env, jclass cls, jint line) {
  return rpsfish_analysis_from(line);
}

JNIEXPORT jint JNICALL RPSFISH_JNI(analysisTo)(JNIEnv *env, jclass cls, jint line) {
  return rpsfish_analysis_to(line);
}

JNIEXPORT jint JNICALL RPSFISH_JNI(analysisLineScore)(JNIEnv *env, jclass cls, jint line) {
  return rpsfish_analysis_line_score(line);
}

JNIEXPORT jint JNICALL RPSFISH_JNI(analysisPvLength)(JNIEnv *env, jclass cls, jint line) {
  return rpsfish_analysis_pv_length(line);
}

JNIEXPORT jint JNICALL RPSFISH_JNI(analysisPvFrom)(JNIEnv *env, jclass cls, jint line, jint ply) {
  return rpsfish_analysis_pv_from(line, ply);
}

JNIEXPORT jint JNICALL RPSFISH_JNI(analysisPvTo)(JNIEnv *env, jclass cls, jint line, jint ply) {
  return rpsfish_analysis_pv_to(line, ply);
}
