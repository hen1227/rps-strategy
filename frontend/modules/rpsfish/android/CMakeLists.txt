# Copyright (C) 2026 Henhen1227, LLC
# SPDX-License-Identifier: LGPL-3.0-or-later
#
# The engine's static library, wrapped in the JNI library the Kotlin module
# loads. The engine stays a C ABI with no knowledge of Java; everything that
# knows about the JVM is in src/main/cpp/rpsfish_jni.c.

cmake_minimum_required(VERSION 3.22.1)
project(rpsfish_jni C)

# Built by `npm run build:rpsfish:android`, which copies the engine's library
# for each ABI here with its header. It is a build artifact rather than source,
# so it is not in the repository; the root .easignore says how it reaches EAS.
set(RPSFISH_LIBS "${CMAKE_CURRENT_SOURCE_DIR}/libs")
if(NOT EXISTS "${RPSFISH_LIBS}/${ANDROID_ABI}/librpsfish.a")
  message(FATAL_ERROR
    "No RPSFish engine for ${ANDROID_ABI} in ${RPSFISH_LIBS}. "
    "Run `npm run build:rpsfish:android` in frontend/ first.")
endif()

add_library(rpsfish STATIC IMPORTED)
set_target_properties(rpsfish PROPERTIES
  IMPORTED_LOCATION "${RPSFISH_LIBS}/${ANDROID_ABI}/librpsfish.a")

add_library(rpsfish_jni SHARED src/main/cpp/rpsfish_jni.c)
target_include_directories(rpsfish_jni PRIVATE "${RPSFISH_LIBS}/include")
# What the Rust standard library needs on Android, from
# `rustc --print native-static-libs`. The NDK supplies libunwind itself.
target_link_libraries(rpsfish_jni rpsfish log dl m)
target_link_options(rpsfish_jni PRIVATE
  # Only the JNI entry points are this library's interface; the engine's own
  # symbols stay inside it.
  "-Wl,--exclude-libs,ALL"
  "-Wl,--gc-sections"
  "-Wl,-z,max-page-size=16384")
