#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENGINE_DIR="${ROOT_DIR}/RPSFish"
WEB_DIR="${ROOT_DIR}/frontend/public/rpsfish"
WASM="${WEB_DIR}/rpsfish.wasm"
CLIENT="${ROOT_DIR}/frontend/src/engine/rpsfish/client.ts"

if command -v shasum >/dev/null 2>&1; then
  digest() { shasum -a 256 "$1" | cut -c1-12; }
else
  digest() { sha256sum "$1" | cut -c1-12; }
fi

# The website fetches this file at runtime, so "deploying" the engine means
# staging it into the frontend's static folder. `expo export` copies public/
# into dist/ verbatim, and the wasm is gitignored there because it is a build
# artifact -- it has to be rebuilt before every web deploy.
PREVIOUS="none"
if [ -f "${WASM}" ]; then
  PREVIOUS="$(digest "${WASM}")"
fi

echo "Building RPSFish WebAssembly..."
"${ENGINE_DIR}/scripts/build_web.sh"

CURRENT="$(digest "${WASM}")"
VERSION="$(git -C "${ENGINE_DIR}" describe --tags --always --dirty 2>/dev/null || echo unknown)"
SIZE="$(wc -c <"${WASM}" | tr -d ' ')"

echo
echo "Engine version: ${VERSION}"
echo "Artifact:       ${WASM}"
echo "Size:           ${SIZE} bytes"
if [ "${PREVIOUS}" = "${CURRENT}" ]; then
  echo "Digest:         ${CURRENT} (unchanged)"
else
  echo "Digest:         ${CURRENT} (was ${PREVIOUS})"
fi

# The worker and the wasm share one cache key, so a stale key serves returning
# visitors an old worker against a new binary. Catch the mismatch here rather
# than in the browser.
if command -v node >/dev/null 2>&1; then
  ENGINE_ABI="$(node -e '
const fs = require("fs");
WebAssembly.instantiate(fs.readFileSync(process.argv[1]), {
  env: { rpsfish_now_ms: () => 0 },
})
  .then(({ instance }) => {
    process.stdout.write(String(instance.exports.rpsfish_abi_version()));
  })
  .catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
' "${WASM}")"
  ASSET_VERSION=""
  if [ -f "${CLIENT}" ]; then
    ASSET_VERSION="$(sed -n "s/^const RPSFISH_ASSET_VERSION = '\(.*\)';$/\1/p" "${CLIENT}")"
  fi
  echo "Engine ABI:     ${ENGINE_ABI} (asset version '${ASSET_VERSION}')"
  case "${ASSET_VERSION}" in
    "abi${ENGINE_ABI}-"*) ;;
    "")
      echo
      echo "WARNING: could not read RPSFISH_ASSET_VERSION from"
      echo "         ${CLIENT#${ROOT_DIR}/}"
      echo "         The worker/wasm cache-key check did not run. Fix CLIENT in"
      echo "         deploy-engine.sh if the client moved or was renamed."
      ;;
    *)
      echo
      echo "WARNING: RPSFISH_ASSET_VERSION does not match ABI ${ENGINE_ABI}."
      echo "         Bump it in ${CLIENT#${ROOT_DIR}/} so returning visitors do"
      echo "         not load a cached worker against this binary."
      ;;
  esac
fi

echo
echo "Engine staged for the website. Publish it with:"
echo "  (cd ${ROOT_DIR}/frontend && npm run deploy)"
