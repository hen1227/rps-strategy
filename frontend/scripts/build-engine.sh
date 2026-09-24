#!/bin/sh
#
# Build the RPSFish engine and put its artifacts where the app expects them.
#
# The engine lives in its own repository. Before the monorepo it was a sibling
# directory and its build scripts wrote straight into ../frontend, which worked
# only because of where the two happened to sit on disk. The app is a directory
# deeper now, so that no longer lands anywhere useful. This script is the seam:
# it locates the engine, runs the engine's own build, and copies the result out
# of the engine's target/ directory into this app. Nothing in the engine
# repository has to know this repository exists.
#
# Usage: build-engine.sh [web|ios]      (default: web)
#
# Set RPSFISH_DIR to build against a checkout somewhere else:
#   RPSFISH_DIR=~/src/rpsfish npm run build:rpsfish

set -eu

RPSFISH_WHAT=${1:-web}
APP_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
REPO_DIR=$(dirname -- "$APP_DIR")

find_engine() {
  if [ -n "${RPSFISH_DIR:-}" ]; then
    printf '%s\n' "$RPSFISH_DIR"
    return 0
  fi
  # A sibling checkout of the engine repository, then the pre-monorepo layout
  # this project grew up in, so an existing machine keeps working untouched.
  for candidate in \
    "$REPO_DIR/../rpsfish" \
    "$REPO_DIR/../RPSFish" \
    "$HOME/RockPaperScissors/RPSFish"
  do
    if [ -f "$candidate/Cargo.toml" ]; then
      (CDPATH= cd -- "$candidate" && pwd)
      return 0
    fi
  done
  return 1
}

if ! ENGINE_DIR=$(find_engine); then
  cat >&2 <<EOF
Could not find the RPSFish engine.

Clone it next to this repository:
  git clone git@github.com:hen1227/rpsfish.git $REPO_DIR/../rpsfish

or point at an existing checkout:
  RPSFISH_DIR=/path/to/rpsfish $0 $RPSFISH_WHAT
EOF
  exit 1
fi

echo "Using RPSFish engine at $ENGINE_DIR"

case "$RPSFISH_WHAT" in
  web)
    # The engine stages a copy of its own as well, into a path it derives from
    # where *it* sits — which was this app's public folder before the monorepo
    # and is a directory outside both repositories now. The copy below is still
    # the authoritative one, so that this script does not depend on where the
    # engine chooses to put things; pointing the engine at the same destination
    # only stops it leaving a stray tree behind on every build.
    RPSFISH_WEB_DIR="$APP_DIR/public/rpsfish" "$ENGINE_DIR/scripts/build_web.sh"
    WASM="$ENGINE_DIR/target/wasm32-unknown-unknown/release/rpsfish.wasm"
    [ -f "$WASM" ] || { echo "Engine build produced no $WASM" >&2; exit 1; }
    mkdir -p "$APP_DIR/public/rpsfish"
    cp "$WASM" "$APP_DIR/public/rpsfish/rpsfish.wasm"
    chmod 644 "$APP_DIR/public/rpsfish/rpsfish.wasm"
    echo "RPSFish WebAssembly copied to $APP_DIR/public/rpsfish/rpsfish.wasm"
    ;;
  ios)
    "$ENGINE_DIR/scripts/build_ios.sh"
    FRAMEWORK="$ENGINE_DIR/target/ios/RPSFish.xcframework"
    [ -d "$FRAMEWORK" ] || { echo "Engine build produced no $FRAMEWORK" >&2; exit 1; }
    mkdir -p "$APP_DIR/modules/rpsfish/ios"
    rm -rf "$APP_DIR/modules/rpsfish/ios/RPSFish.xcframework"
    cp -R "$FRAMEWORK" "$APP_DIR/modules/rpsfish/ios/RPSFish.xcframework"
    echo "RPSFish XCFramework copied to $APP_DIR/modules/rpsfish/ios/"
    ;;
  *)
    echo "Usage: $0 [web|ios]" >&2
    exit 1
    ;;
esac
