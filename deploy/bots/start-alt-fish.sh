#!/bin/bash

# Run ALTFish, the second online bot. See start-rps-fish.sh for how the paths
# are derived and what --book does. Drop --book here if you want ALTFish kept
# as a bookless control to measure the book against.

set -eu

HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO=$(CDPATH= cd -- "$HERE/../.." && pwd)
ENGINE=${RPSFISH_DIR:-$REPO/../rpsfish}

if [ ! -x "$ENGINE/target/release/rpsfish" ]; then
  echo "No engine binary at $ENGINE/target/release/rpsfish" >&2
  echo "Build it with: cargo build --release --manifest-path $ENGINE/Cargo.toml" >&2
  exit 1
fi

cd "$HERE" && python3 "$REPO/backend/internal/botclient/rpsbot.py" \
  --config "$HERE/altbot.conf" \
  -- "$ENGINE/target/release/rpsfish" rpsi --hash-mb 512 --book "$ENGINE/book"
