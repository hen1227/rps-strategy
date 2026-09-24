#!/usr/bin/env bash

# Ship the daily Hugging Face export.
#
# Deliberately a second script rather than a flag on deploy-backend.sh, because
# the two have opposite risk profiles. Deploying the backend replaces the binary
# people are playing on and has to drain games to do it safely. This touches
# nothing that is running: it installs a binary, a script, a virtualenv and two
# systemd units, none of which the game server reads. It never restarts
# rps-strategy.service, and it needs no admin token — the export reads SQLite
# directly, so there is no API call to authenticate.
#
# It is also idempotent. Run it again after changing export.py, or after
# bumping a pinned dependency, and it reinstalls what changed and leaves
# export.env, the ledger and the staging directory alone. The one thing it will
# not do is overwrite export.env, because that file holds the key secret and
# rewriting it would repartition every player in the published data set.
#
#   ./deploy/deploy-export.sh            install or update everything
#   ./deploy/deploy-export.sh --check    preflight only, build and install nothing
#   ./deploy/deploy-export.sh --run      install, then run one export now
#
# The first install needs export.env filled in by hand; this script creates it
# from the template and stops, because the alternative is a timer that fires at
# 04:17 against a placeholder token.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
BACKEND_DIR="${ROOT_DIR}/backend"
REMOTE_HOST="server2"
REMOTE_DIR="/var/www/production/henhen1227/api-rps.henhen1227.com"
EXPORT_DIR="${REMOTE_DIR}/export"
BUILD_DIR="$(mktemp -d)"
trap 'rm -rf -- "${BUILD_DIR}"' EXIT

SERVICE="rps-hf-export.service"
TIMER="rps-hf-export.timer"

CHECK_ONLY=0
RUN_NOW=0
while [ $# -gt 0 ]; do
  case "$1" in
    --check) CHECK_ONLY=1 ;;
    --run)   RUN_NOW=1 ;;
    -h|--help) sed -n '3,26p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

say() { printf '%s\n' "$*"; }

# ---------------------------------------------------------------------------
# Preflight. Everything that can be known before a single byte is uploaded.
# ---------------------------------------------------------------------------

say "Checking the remote host..."
if ! ssh -o BatchMode=yes "${REMOTE_HOST}" true 2>/dev/null; then
  say "  cannot reach ${REMOTE_HOST} over ssh" >&2
  exit 1
fi

# python3 is assumed present by deploy-backend.sh too, but it assumes it on the
# *deploy* machine. This is the first thing in this repository that needs it on
# the server, so it is worth asking rather than discovering during the venv step.
say "Checking python3 on ${REMOTE_HOST}..."
REMOTE_PYTHON="$(ssh "${REMOTE_HOST}" "python3 --version 2>&1 || true")"
if ! printf '%s' "${REMOTE_PYTHON}" | grep -q '^Python 3'; then
  say "  no usable python3 on ${REMOTE_HOST}: ${REMOTE_PYTHON}" >&2
  say "  install it with: sudo apt install python3 python3-venv" >&2
  exit 1
fi
say "  ${REMOTE_PYTHON}"

say "Checking the database the export will read..."
if ! ssh "${REMOTE_HOST}" "sudo test -r ${REMOTE_DIR}/rps-strategy.sqlite"; then
  say "  ${REMOTE_DIR}/rps-strategy.sqlite is not readable" >&2
  exit 1
fi

if [ "${CHECK_ONLY}" = "1" ]; then
  say "Preflight passed. Nothing built, nothing installed."
  exit 0
fi

# ---------------------------------------------------------------------------
# Build. Without -tags meaf, and that is load-bearing rather than incidental:
# the meaf.us archive is embedded behind that tag, so a binary built without it
# structurally cannot emit those games. They are Meaf's to publish, not this
# site's, and this is what makes that a property of the build rather than a
# promise in a comment.
# ---------------------------------------------------------------------------

say "Building the exporter for Linux ARM64..."
(
  cd "${BACKEND_DIR}"
  CGO_ENABLED=0 GOOS=linux GOARCH=arm64 \
    go build -trimpath -ldflags="-s -w" \
      -o "${BUILD_DIR}/rps-exportgames-arm64" ./cmd/exportgames
)

say "Uploading..."
scp -q \
  "${BUILD_DIR}/rps-exportgames-arm64" \
  "${ROOT_DIR}/tools/hf-export/export.py" \
  "${ROOT_DIR}/tools/hf-export/requirements.txt" \
  "${ROOT_DIR}/tools/hf-export/dataset-card.md" \
  "${BACKEND_DIR}/deploy/rps-hf-export.service" \
  "${BACKEND_DIR}/deploy/rps-hf-export.timer" \
  "${BACKEND_DIR}/deploy/rps-hf-export.env.example" \
  "${REMOTE_HOST}:/tmp/"

# ---------------------------------------------------------------------------
# Install. One ssh, so a half-finished install is a connection drop rather than
# a script that gave up between two of six steps.
# ---------------------------------------------------------------------------

say "Installing on ${REMOTE_HOST}..."
ssh -t "${REMOTE_HOST}" "set -eu
  EXPORT=${EXPORT_DIR}

  # state/ and staging/ are the only two paths the unit may write, so they have
  # to exist and belong to the user it runs as before it ever fires.
  sudo install -d -o root     -g www-data -m 0750 \"\$EXPORT\"
  sudo install -d -o www-data -g www-data -m 0770 \"\$EXPORT/state\" \"\$EXPORT/staging\"

  sudo install -o root -g www-data -m 0750 /tmp/rps-exportgames-arm64 \"\$EXPORT/\"
  sudo install -o root -g www-data -m 0640 /tmp/export.py             \"\$EXPORT/\"
  sudo install -o root -g www-data -m 0640 /tmp/dataset-card.md       \"\$EXPORT/\"
  sudo install -o root -g root     -m 0644 /tmp/requirements.txt      \"\$EXPORT/\"

  # Never overwritten: it holds RPS_EXPORT_KEY_SECRET, and replacing that
  # silently regroups every player in every file published afterwards.
  if [ ! -f \"\$EXPORT/export.env\" ]; then
    sudo install -o root -g www-data -m 0640 /tmp/rps-hf-export.env.example \"\$EXPORT/export.env\"
    echo '  created export.env from the template — it still needs filling in'
  else
    echo '  export.env already present, left alone'
  fi

  if [ ! -x \"\$EXPORT/venv/bin/python\" ]; then
    echo '  creating the virtualenv...'
    sudo python3 -m venv \"\$EXPORT/venv\"
  fi
  echo '  installing pinned dependencies...'
  sudo \"\$EXPORT/venv/bin/pip\" install --quiet --upgrade pip
  sudo \"\$EXPORT/venv/bin/pip\" install --quiet -r \"\$EXPORT/requirements.txt\"
  sudo \"\$EXPORT/venv/bin/python\" -c 'import huggingface_hub, pyarrow; print(\"  deps ok:\", huggingface_hub.__version__, pyarrow.__version__)'

  sudo cp /tmp/${SERVICE} /tmp/${TIMER} /etc/systemd/system/
  sudo systemctl daemon-reload
  rm -f /tmp/rps-exportgames-arm64 /tmp/export.py /tmp/requirements.txt /tmp/dataset-card.md \
        /tmp/${SERVICE} /tmp/${TIMER} /tmp/rps-hf-export.env.example
"

# ---------------------------------------------------------------------------
# Refuse to arm a timer that would fire against a placeholder.
# ---------------------------------------------------------------------------

say "Checking export.env..."
PLACEHOLDERS="$(ssh "${REMOTE_HOST}" \
  "sudo grep -c '^[A-Z_]*=replace-with' ${EXPORT_DIR}/export.env || true")"
if [ "${PLACEHOLDERS:-0}" != "0" ]; then
  cat >&2 <<EOF

  ${EXPORT_DIR}/export.env still has ${PLACEHOLDERS} placeholder value(s).

  Fill them in, then run this script again to enable the timer:

    ssh ${REMOTE_HOST}
    openssl rand -hex 32                     # for RPS_EXPORT_KEY_SECRET
    sudoedit ${EXPORT_DIR}/export.env

  Back up RPS_EXPORT_KEY_SECRET somewhere. It is what makes the published
  player keys opaque, and a new one regroups every player in every future file.

EOF
  exit 1
fi

say "Enabling the timer..."
ssh "${REMOTE_HOST}" "sudo systemctl enable --now ${TIMER}"
ssh "${REMOTE_HOST}" "systemctl list-timers ${TIMER} --no-pager"

if [ "${RUN_NOW}" = "1" ]; then
  say ""
  say "Running one export now..."
  # `|| true` so the log is printed either way: a failed first run is exactly
  # the one whose journal is worth reading.
  ssh "${REMOTE_HOST}" "sudo systemctl start ${SERVICE}" || true
  ssh "${REMOTE_HOST}" "sudo journalctl -u ${SERVICE} -n 40 --no-pager"
fi

say ""
say "Done. The timer fires daily at 04:17 UTC."
say "  logs:   ssh ${REMOTE_HOST} sudo journalctl -u ${SERVICE} -n 50 --no-pager"
say "  now:    ssh ${REMOTE_HOST} sudo systemctl start ${SERVICE}"
