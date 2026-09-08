#!/bin/bash

# Run RPSFish as an online bot.
#
# Paths are derived from where this script sits rather than hardcoded, because
# the engine is a separate repository now: it is expected beside this one, and
# RPSFISH_DIR overrides that the same way frontend/scripts/build-engine.sh does.
#
# --book points at the directory scripts/build_books.sh writes, which holds one
# book per mode by wire code. A mode with no book there -- or a book built under
# other evaluation weights -- is searched exactly as before, with the reason on
# an `info string`, so this flag is safe to leave on while a book is rebuilding.

set -eu

HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO=$(CDPATH= cd -- "$HERE/../.." && pwd)
ENGINE=${RPSFISH_DIR:-$REPO/../rpsfish}

if [ ! -x "$ENGINE/target/release/rpsfish" ]; then
  echo "No engine binary at $ENGINE/target/release/rpsfish" >&2
  echo "Build it with: cargo build --release --manifest-path $ENGINE/Cargo.toml" >&2
  exit 1
fi

cd "$REPO" && python3 ./backend/internal/botclient/rpsbot.py \
  --config "$HERE/rpsbot.conf" \
  -- "$ENGINE/target/release/rpsfish" rpsi --hash-mb 512 --book "$ENGINE/book"
