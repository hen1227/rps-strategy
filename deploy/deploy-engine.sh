#!/usr/bin/env bash

set -euo pipefail

# Two repositories, and the paths below are the seam between them.
#
# This script lives in deploy/, and the website it stages the engine into is a
# sibling of that directory rather than a child of it. RPSFish is neither: it is
# its own repository, checked out beside rps-strategy instead of inside it,
# because it is released separately and under a different licence. So there are
# three roots here rather than one, and each is derived from where this file
# sits rather than from the working directory — the script gets run from the
# repository root, from deploy/, and from wherever a terminal happened to be.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
WEB_DIR="${ROOT_DIR}/frontend/public/rpsfish"
WASM="${WEB_DIR}/rpsfish.wasm"

# The constant that carries the cache key. It lives with the code that reads it,
# which is the web worker entry point and not the client — it is the worker's
# own URL that the query string is appended to. This is a path into somebody
# else's file and it has moved once already, so the check below is written to
# say so plainly rather than to quietly pass when it cannot find it.
CLIENT="${ROOT_DIR}/frontend/src/engine/rpsfish/engineWorker.web.ts"

# RPSFISH_DIR is for the machine that keeps the engine somewhere other than
# beside this repository. The default is the ordinary checkout.
ENGINE_DIR="${RPSFISH_DIR:-${ROOT_DIR}/../rpsfish}"
if [ -d "${ENGINE_DIR}" ]; then
  # Resolved once, so the version stamp and every message below name a path a
  # person could type rather than one with a ../ in the middle of it.
  ENGINE_DIR="$(cd "${ENGINE_DIR}" && pwd)"
fi
BUILD_WEB="${ENGINE_DIR}/scripts/build_web.sh"
if [ ! -x "${BUILD_WEB}" ]; then
  cat >&2 <<EOF
Cannot find the RPSFish build script, which should be at

  ${BUILD_WEB}

RPSFish is a separate repository and is expected beside this one, so that it and

  ${ROOT_DIR}

are siblings. Either clone it there, or say where it is:

  RPSFISH_DIR=/path/to/rpsfish $0
EOF
  exit 1
fi

if command -v shasum >/dev/null 2>&1; then
  digest() { shasum -a 256 "$1" | cut -c1-12; }
else
  digest() { sha256sum "$1" | cut -c1-12; }
fi

# The website fetches this file at runtime, so "deploying" the engine means
# staging it into the frontend's static folder. `expo export` copies public/
# into dist/ verbatim, and the wasm is gitignored there because it is a build
# artifact — it has to be rebuilt before every web deploy.
PREVIOUS="none"
if [ -f "${WASM}" ]; then
  PREVIOUS="$(digest "${WASM}")"
fi

echo "Building RPSFish WebAssembly..."
# The engine's own default stages the wasm beside *its* checkout, which was the
# right guess while the two repositories were one tree and is the wrong one now.
# Telling it where the website actually is beats letting it write into a
# directory nobody serves: that copy would create the directory and report
# success, so the deploy would look exactly like a working one right up until a
# visitor got a stale engine.
RPSFISH_WEB_DIR="${WEB_DIR}" "${BUILD_WEB}"

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
      echo "         deploy-engine.sh: the constant has moved between files once"
      echo "         already, and this warning is what that looks like."
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
