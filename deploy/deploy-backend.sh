#!/usr/bin/env bash

# Deploying without taking a game off anybody.
#
# This used to be four lines: build, upload, install, `systemctl restart`. That
# is honest about what it does — every socket drops, every board on screen goes
# away, and whatever was being played is archived as Interrupted, a result
# nobody earned. It was fine when the lobby was empty most of the time. It is
# not fine now that there are engines connected around the clock and a game or
# two nearly always on the board.
#
# So the order changed, and the order is the whole design:
#
#   1. Build and upload, which touches nothing that is running.
#   2. *Install the new binary*, while the old one is still serving. A running
#      process holds its own inode, so replacing the file underneath it is safe
#      and invisible to it.
#   3. Ask the server to drain: stop taking new games, play out the ones on the
#      board. It broadcasts a banner so nobody is left wondering why the play
#      button stopped working.
#   4. Watch it, printing what it is still waiting on.
#   5. The server exits by itself when the last game ends, and systemd's
#      Restart=always brings up the binary from step 2. Nothing here runs
#      `systemctl restart`, which is why there is no gap between the last move
#      and the new build.
#   6. Confirm the process that is now answering is the new one, by its build
#      stamp rather than by hoping.
#
# `--now` skips the waiting and restarts immediately, which is the old
# behaviour, for the fix that cannot wait for a game to finish. Use
# `--say "..."` with it: an apology posted before the plug is pulled is the
# difference between a bug and a bad afternoon.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="${ROOT_DIR}/backend"
# REMOTE_HOST="rangeley-loc-server"
REMOTE_HOST="server2"
REMOTE_DIR="/var/www/production/henhen1227/api-rps.henhen1227.com"
REMOTE_BINARY="${REMOTE_DIR}/rps-server-arm64"
REMOTE_UPLOAD="/tmp/rps-server-arm64"
SERVICE="rps-strategy.service"
SOCKET="/var/www/production/henhen1227/rps-henhen1227-backend.sock"

# How long to wait for the games on the board. The server enforces its own
# deadline (twelve minutes) and restarts regardless once it passes; this is a
# little longer, so a timeout here means the *script* lost track of the server
# rather than the server giving up on a game.
DRAIN_TIMEOUT_SECONDS=900
# How often to ask. Two seconds is the lobby's own tick, so polling faster only
# reprints the same answer.
POLL_SECONDS=3
# How long to wait for systemd to bring the new process back up. Restart=always
# with RestartSec=3s, so this is generous by a wide margin.
RESTART_TIMEOUT_SECONDS=90

IMMEDIATE=0
NOTE=""

usage() {
  cat <<'USAGE'
Usage: deploy-backend.sh [--now] [--say "message"]

  --say "message"   What players are told, on the banner and in the refusal
                    when they try to start a game. Defaults to a generic line.
  --now             Do not wait for games to finish. Posts the message as an
                    announcement first, then restarts immediately. Games still
                    on the board are archived unfinished.
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --now) IMMEDIATE=1; shift ;;
    --say) NOTE="${2-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

# The admin token, which is how the drain and the announcement are authorised.
# Read from the environment if it is there, and otherwise off the server's own
# .env — the host running this deploy is the host that wrote that file, so
# asking them to keep a second copy in their shell is a way to have the two
# drift apart.
admin_token() {
  if [ -n "${RPS_ADMIN_TOKEN:-}" ]; then
    printf '%s' "${RPS_ADMIN_TOKEN}"
    return
  fi
  ssh "${REMOTE_HOST}" \
    "sudo sed -n 's/^RPS_ADMIN_TOKEN=//p' ${REMOTE_DIR}/.env | tail -n 1 | tr -d '\"'"
}

# Every call goes over the unix socket from the server itself, so nothing here
# depends on the public hostname resolving, on TLS, or on nginx being up.
#
# The status code is kept rather than collapsed into an exit code, because one
# specific failure is not a failure at all: a 404 from /api/admin/drain means the
# *running* build predates the drain, which is exactly what is true during the
# deploy that introduces it. `--fail` would report that identically to a bad
# token, and the two want opposite responses. API_STATUS is 000 when the request
# never got an answer, which after a drain means the server has exited — the
# success condition of the whole script.
API_STATUS=000
api() {
  local method="$1" path="$2" body="${3-}"
  local args=(--silent --show-error --unix-socket "${SOCKET}"
              --write-out '\nHTTP_STATUS:%{http_code}'
              -X "${method}" -H "Authorization: Bearer ${TOKEN}")
  if [ -n "${body}" ]; then
    args+=(-H 'Content-Type: application/json' --data "${body}")
  fi
  local out
  if ! out="$(ssh "${REMOTE_HOST}" \
      "sudo curl $(printf '%q ' "${args[@]}") http://localhost${path}" 2>/dev/null)"; then
    API_STATUS=000
    return 1
  fi
  API_STATUS="$(sed -n 's/^HTTP_STATUS://p' <<<"${out}" | tail -n 1)"
  : "${API_STATUS:=000}"
  sed '/^HTTP_STATUS:/d' <<<"${out}"
  [ "${API_STATUS}" -ge 200 ] && [ "${API_STATUS}" -lt 300 ]
}

# The one restart this script would rather not do, kept in one place because two
# paths reach it: `--now`, and a first deploy onto a build with no drain in it.
restart_now() {
  ssh -t "${REMOTE_HOST}" "sudo systemctl restart ${SERVICE}"
}

health() {
  ssh "${REMOTE_HOST}" \
    "sudo curl --fail --silent --show-error --unix-socket ${SOCKET} http://localhost/healthz"
}

# jq is not installed everywhere, and these are two fields of a flat object.
field() { sed -n "s/.*\"$2\":\"\([^\"]*\)\".*/\1/p" <<<"$1"; }
number() { sed -n "s/.*\"$2\":\([0-9]*\).*/\1/p" <<<"$1"; }
flag() { grep -q "\"$2\":true" <<<"$1" && echo true || echo false; }

BUILD_DIR="$(mktemp -d)"
LOCAL_BINARY="${BUILD_DIR}/rps-server-arm64"
trap 'rm -rf -- "${BUILD_DIR}"' EXIT

# The stamp that tells the new process from the old one. Anything unique will
# do; the time and the short commit are the two things worth reading in a log.
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
if COMMIT="$(git -C "${ROOT_DIR}" rev-parse --short HEAD 2>/dev/null)"; then
  STAMP="${STAMP}-${COMMIT}"
fi

echo "Building Linux ARM64 backend (${STAMP})..."
(
  cd "${BACKEND_DIR}"
  CGO_ENABLED=0 GOOS=linux GOARCH=arm64 \
    go build -trimpath -tags meaf \
      -ldflags="-s -w -X rps-strategy/backend/internal/server.build=${STAMP}" \
      -o "${LOCAL_BINARY}" ./cmd/server
)

echo "Reading the running build..."
# Tolerant of every answer, including no answer. A server that is down is still
# a server worth deploying to — arguably the one most worth deploying to — and
# `set -e` would otherwise end the script here. An empty BEFORE is also what the
# build *before* this change reports, since its /healthz carries no stamp, and
# the wait at the end only needs the two to differ.
BEFORE="$(field "$(health 2>/dev/null || true)" build)"
echo "  currently serving: ${BEFORE:-unknown}"

echo "Uploading backend to ${REMOTE_HOST}..."
scp "${LOCAL_BINARY}" "${REMOTE_HOST}:${REMOTE_UPLOAD}"

# Installed *before* the restart is asked for, and that ordering is the point:
# when the old process exits, systemd starts whatever is at this path, so the
# new build has to already be there. A running process keeps its own inode, so
# it does not notice this at all.
echo "Installing the new binary alongside the running one..."
ssh -t "${REMOTE_HOST}" \
  "set -eu
   trap 'rm -f -- ${REMOTE_UPLOAD}' EXIT
   sudo install -o root -g www-data -m 0750 \
     ${REMOTE_UPLOAD} ${REMOTE_BINARY}.new
   sudo mv -f -- ${REMOTE_BINARY}.new ${REMOTE_BINARY}"

TOKEN="$(admin_token)"
if [ -z "${TOKEN}" ]; then
  echo "Could not read RPS_ADMIN_TOKEN. Set it in the environment and retry." >&2
  exit 1
fi

json_string() {
  printf '%s' "$1" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))'
}

if [ "${IMMEDIATE}" -eq 1 ]; then
  if [ -n "${NOTE}" ]; then
    echo "Announcing: ${NOTE}"
    if api POST /api/admin/notice \
        "{\"text\":$(json_string "${NOTE}"),\"tone\":\"warning\"}" >/dev/null; then
      # A moment for the announcement to reach the sockets it was written to,
      # before those sockets are closed. Without it the apology races the
      # disconnection it is apologising for.
      sleep 2
    elif [ "${API_STATUS}" = "404" ]; then
      # The running build cannot say anything to anybody. Worth a line, not
      # worth stopping a restart over — the restart is the point.
      echo "  (the running build has no announcements; skipping)" >&2
    else
      echo "  could not post the announcement (HTTP ${API_STATUS}); restarting anyway" >&2
    fi
  fi
  echo "Restarting now, without waiting for games..."
  restart_now
else
  echo "Asking the server to finish its games and restart..."
  if ! api POST /api/admin/drain \
      "{\"note\":$(json_string "${NOTE:-A new version is on the way.}")}" >/dev/null; then
    case "${API_STATUS}" in
      404)
        # The bootstrap case, and the only deploy that ever hits it: the build
        # that is *running* has no drain endpoint, because the build being
        # installed is the one that adds it. There is nothing to ask, so this
        # one restart is the blunt kind — which is what every deploy was before
        # today, and what every deploy after this one will not be.
        echo
        echo "The running build has no /api/admin/drain: this is the deploy that adds it."
        echo "Restarting the blunt way, once. Games on the board now are archived"
        echo "unfinished, as they were before this change. From the next deploy on,"
        echo "this script waits for them."
        echo
        restart_now
        # Nothing to watch: there is no drain, only a restart already under way.
        # Falling through to the poll loop would ask the *new* server about a
        # drain it is not under, and wait out the timeout being told so.
        BOOTSTRAPPED=1
        ;;
      401|403)
        echo "The admin token was refused (HTTP ${API_STATUS})." >&2
        echo "The new binary is installed but nothing has restarted." >&2
        exit 1
        ;;
      000)
        echo "The server did not answer. Is ${SERVICE} running?" >&2
        exit 1
        ;;
      *)
        echo "Could not start the drain (HTTP ${API_STATUS})." >&2
        echo "The new binary is installed but nothing has restarted." >&2
        exit 1
        ;;
    esac
  fi

  deadline=$(( $(date +%s) + DRAIN_TIMEOUT_SECONDS ))
  last=""
  while [ "${BOOTSTRAPPED:-0}" -eq 0 ]; do
    # The server stops answering the moment it exits, and that is the success
    # condition rather than an error — so a failed read here breaks the loop
    # and the restart check below decides what it meant.
    if ! state="$(api GET /api/admin/drain 2>/dev/null)"; then
      echo "  the server has stopped; systemd is starting the new build"
      break
    fi
    remaining="$(number "${state}" gamesRemaining)"
    if [ "$(flag "${state}" settled)" = true ]; then
      echo "  nothing left to play; stopping"
      break
    fi
    # Somebody called the drain off from the admin screen while this was
    # watching. Their decision, not an error — but this script has nothing left
    # to wait for, and must not sit here until the timeout pretending it does.
    if [ "$(flag "${state}" updating)" != true ]; then
      echo "The drain was called off; the server is back in play." >&2
      echo "The new binary is installed and starts on the next restart." >&2
      exit 1
    fi
    if [ "${remaining:-0}" = "0" ]; then
      echo "  nothing left to play"
    else
      # Printed only when it changes, so a ten-minute game does not produce two
      # hundred identical lines.
      line="  waiting on ${remaining} game(s): $(sed -n 's/.*"waitingOn":\[\([^]]*\)\].*/\1/p' <<<"${state}" | tr -d '"')"
      if [ "${line}" != "${last}" ]; then
        echo "${line}"
        last="${line}"
      fi
    fi
    if [ "$(date +%s)" -ge "${deadline}" ]; then
      echo "Gave up waiting after ${DRAIN_TIMEOUT_SECONDS}s." >&2
      echo "The drain is still on. Either wait, or call it off with:" >&2
      echo "  curl -X DELETE --unix-socket ${SOCKET} -H 'Authorization: Bearer \$RPS_ADMIN_TOKEN' http://localhost/api/admin/drain" >&2
      exit 1
    fi
    sleep "${POLL_SECONDS}"
  done
fi

echo "Waiting for the new build to come up..."
deadline=$(( $(date +%s) + RESTART_TIMEOUT_SECONDS ))
while :; do
  if body="$(health 2>/dev/null)"; then
    after="$(field "${body}" build)"
    if [ -n "${after}" ] && [ "${after}" != "${BEFORE}" ]; then
      echo "  now serving: ${after}"
      break
    fi
  fi
  if [ "$(date +%s)" -ge "${deadline}" ]; then
    echo "The service did not come back with a new build in ${RESTART_TIMEOUT_SECONDS}s." >&2
    ssh "${REMOTE_HOST}" "sudo systemctl status ${SERVICE} --no-pager --lines 20" >&2 || true
    exit 1
  fi
  sleep 2
done

# The stamp only says a different process is answering. This says it is the one
# that was just built.
if [ "${after}" != "${STAMP}" ]; then
  echo "Warning: the running build is ${after}, not the ${STAMP} just uploaded." >&2
fi

ssh "${REMOTE_HOST}" "sudo systemctl is-active --quiet ${SERVICE}"

echo
echo "Backend deployment completed successfully."
