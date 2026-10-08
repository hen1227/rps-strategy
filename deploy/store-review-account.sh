#!/usr/bin/env bash
# Make, or put back, the sign-in an app store's reviewers are given.
#
# Run it before every submission, once for each store you are submitting to:
#
#   ./deploy/store-review-account.sh apple --username <name>   the first time
#   ./deploy/store-review-account.sh apple                     every time after
#   ./deploy/store-review-account.sh google --username <name>  and the same for Play
#   ./deploy/store-review-account.sh --list                    show both, change nothing
#
# Reviewers need an account because ranked play, blocking and your own bots all
# sit behind a sign-in, and Discord cannot sign them in: it asks somebody logging
# in from a new place to confirm by email. So each store gets a password account
# of its own, which no player can create — see backend/internal/persistence/
# store_review.go for the rules that keep it working.
#
# A reset puts the account back the way the store was told it is: its name,
# enabled, every device signed out. It keeps the password, because the store
# already has it. A new password is printed only when there is one — the first
# time, after a reviewer deleted the account (they are allowed to, and they
# test it), or with --new-password — and it has to go into the store before the
# next review, or that review cannot sign in.
#
# Nothing is written down by this script. The name and the password belong in
# App Store Connect, the Play Console and your password manager, and never in
# this repository, which is public. docs/store-listing.md has the rest.
#
# It talks to the running server the way deploy-backend.sh does — over ssh, to
# the unix socket, with the admin token — and finds the token the same way.
# RPS_API_URL points it at a server this machine can reach directly instead, such
# as a dev or scratch server; that needs RPS_ADMIN_TOKEN set for it as well.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REMOTE_HOST="server2"
REMOTE_DIR="/var/www/production/henhen1227/api-rps.henhen1227.com"
SOCKET="/var/www/production/henhen1227/rps-henhen1227-backend.sock"
CREDENTIALS_FILE="${RPS_DEPLOY_ENV:-${SCRIPT_DIR}/deploy.env}"
API_URL="${RPS_API_URL:-}"

usage() {
  cat <<'USAGE'
Usage: store-review-account.sh <label> [--username NAME] [--new-password]
       store-review-account.sh --list

  <label>          Which store: apple or google. One lowercase word.
  --username NAME  The name the store has on file. Needed the first time; after
                   that only to change it, and the store must then be told.
  --new-password   Replace a password that still works. Without it the password
                   only changes when the account had to be made again.
  --list           Show every review account and whether it signs in right now.
USAGE
}

LABEL=""
USERNAME=""
NEW_PASSWORD=false
LIST=0
while [ $# -gt 0 ]; do
  case "$1" in
    --username)
      if [ $# -lt 2 ]; then echo "--username needs a name." >&2; exit 2; fi
      USERNAME="$2"; shift 2 ;;
    --username=*) USERNAME="${1#*=}"; shift ;;
    --new-password) NEW_PASSWORD=true; shift ;;
    --list) LIST=1; shift ;;
    -h|--help) usage; exit 0 ;;
    -*) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
    *)
      if [ -n "${LABEL}" ]; then echo "One label at a time." >&2; exit 2; fi
      LABEL="$1"; shift ;;
  esac
done
if [ "${LIST}" = 0 ] && [ -z "${LABEL}" ]; then
  usage >&2
  exit 2
fi

# The admin token, found in the order deploy-backend.sh uses and for the reasons
# it gives there: this environment, then deploy/deploy.env, then the server's own
# .env over ssh, which is the copy the running process actually holds. unquote
# and load_admin_token are copies of the functions in that script; keep the two
# in step.
TOKEN=""
TOKEN_SOURCE=""

unquote() {
  local value="$1"
  value="${value%$'\r'}"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  case "${value}" in
    \"*\") value="${value#\"}"; value="${value%\"}" ;;
    \'*\') value="${value#\'}"; value="${value%\'}" ;;
  esac
  printf '%s' "${value}"
}

load_admin_token() {
  if [ -n "${RPS_ADMIN_TOKEN:-}" ]; then
    TOKEN="$(unquote "${RPS_ADMIN_TOKEN}")"
    TOKEN_SOURCE="the RPS_ADMIN_TOKEN environment variable"
    [ -n "${TOKEN}" ] && return 0
  fi
  # A server named by RPS_API_URL is not production, so production's token is
  # not the one to send it.
  [ -n "${API_URL}" ] && return 1

  if [ -f "${CREDENTIALS_FILE}" ]; then
    local from_file
    from_file="$(set -a; . "${CREDENTIALS_FILE}"; printf '%s' "${RPS_ADMIN_TOKEN:-}")"
    from_file="$(unquote "${from_file}")"
    if [ -n "${from_file}" ]; then
      TOKEN="${from_file}"
      TOKEN_SOURCE="${CREDENTIALS_FILE}"
      return 0
    fi
  fi

  local from_server
  from_server="$(ssh "${REMOTE_HOST}" \
    "sudo sed -n 's/^[[:space:]]*RPS_ADMIN_TOKEN=//p' ${REMOTE_DIR}/.env | tail -n 1" \
    2>/dev/null || true)"
  from_server="$(unquote "${from_server}")"
  if [ -n "${from_server}" ]; then
    TOKEN="${from_server}"
    TOKEN_SOURCE="${REMOTE_HOST}:${REMOTE_DIR}/.env"
    return 0
  fi
  return 1
}

# One request. The reply lands in API_BODY and its status in API_STATUS — 000
# when nothing answered at all. Globals rather than stdout, because the caller
# needs the status as well as the body, and `reply="$(api …)"` would run this in
# a subshell and throw the status away with it.
API_STATUS=000
API_BODY=""
api() {
  local method="$1" path="$2" body="${3-}"
  local args=(--silent --show-error --write-out '\nHTTP_STATUS:%{http_code}'
              -X "${method}" -H "Authorization: Bearer ${TOKEN}")
  if [ -n "${body}" ]; then
    args+=(-H 'Content-Type: application/json' --data "${body}")
  fi
  API_STATUS=000
  API_BODY=""
  local out
  if [ -n "${API_URL}" ]; then
    if ! out="$(curl "${args[@]}" "${API_URL}${path}" 2>/dev/null)"; then
      return 1
    fi
  elif ! out="$(ssh "${REMOTE_HOST}" \
      "sudo curl --unix-socket ${SOCKET} $(printf '%q ' "${args[@]}") http://localhost${path}" \
      2>/dev/null)"; then
    return 1
  fi
  API_STATUS="$(sed -n 's/^HTTP_STATUS://p' <<<"${out}" | tail -n 1)"
  : "${API_STATUS:=000}"
  API_BODY="$(sed '/^HTTP_STATUS:/d' <<<"${out}")"
  [ "${API_STATUS}" -ge 200 ] && [ "${API_STATUS}" -lt 300 ]
}

# Every refusal says why in the same shape, so there is one place that reads it.
explain_failure() {
  local reason
  reason="$(python3 -c 'import json,sys
try:
    print(json.loads(sys.stdin.read()).get("error", ""))
except Exception:
    pass' <<<"${API_BODY}" 2>/dev/null || true)"
  case "${API_STATUS}" in
    000) echo "Nothing answered at ${API_URL:-${REMOTE_HOST}}." >&2 ;;
    401) echo "The server refused the admin token from ${TOKEN_SOURCE}." >&2 ;;
    404)
      echo "The running server has no store review accounts yet." >&2
      echo "Deploy the backend first: ./deploy/deploy-backend.sh" >&2
      ;;
    409)
      echo "Refused: ${reason}" >&2
      echo "Pick another name with --username, and give the store the new one." >&2
      ;;
    *) echo "Refused (${API_STATUS}): ${reason:-no reason given}" >&2 ;;
  esac
}

if ! load_admin_token; then
  if [ -n "${API_URL}" ]; then
    echo "RPS_API_URL is set, so RPS_ADMIN_TOKEN has to be too: the token for that server." >&2
  else
    echo "No admin token. Run ./deploy/deploy-backend.sh --check, which says where it looks." >&2
  fi
  exit 1
fi

if [ "${LIST}" = 1 ]; then
  if ! api GET /api/admin/store-review-accounts; then
    explain_failure
    exit 1
  fi
  python3 -c 'import json,sys
accounts = json.loads(sys.stdin.read())["accounts"]
if not accounts:
    print("No store review accounts yet.")
for account in accounts:
    state = "signs in" if account["signsIn"] else "does NOT sign in; reset it before submitting"
    print("%-8s %-24s %s" % (account["label"], account["username"], state))' <<<"${API_BODY}"
  exit 0
fi

body="$(python3 -c 'import json,sys
request = {"newPassword": sys.argv[2] == "true"}
if sys.argv[1]:
    request["username"] = sys.argv[1]
print(json.dumps(request))' "${USERNAME}" "${NEW_PASSWORD}")"

if ! api PUT "/api/admin/store-review-accounts/${LABEL}" "${body}"; then
  explain_failure
  exit 1
fi

python3 -c 'import json,sys
reset = json.loads(sys.stdin.read())
console, place = {
    "apple": ("App Store Connect", ", in the version'"'"'s App Review Information, under Sign-In Information"),
    "google": ("the Play Console", ", under App content, then App access"),
}.get(reset["label"], ("the store", ""))

print("%s: %s" % (reset["label"], reset["username"]))
if reset.get("created"):
    print("  made a new account (the first for this store, or a reviewer deleted the last one)")
if reset.get("renamedFrom"):
    print("  renamed back from %s" % reset["renamedFrom"])
if reset.get("reEnabled"):
    print("  switched back on")
revoked = reset.get("sessionsRevoked", 0)
if revoked:
    print("  signed out %d device%s" % (revoked, "" if revoked == 1 else "s"))

if reset.get("password"):
    print()
    print("NEW PASSWORD. Any older one no longer works. Put it in %s%s:" % (console, place))
    print()
    print("    %s" % reset["password"])
    print()
    print("It is not shown again. Keep a copy in your password manager.")
else:
    print("Password unchanged: whatever %s was given last still signs in." % console)' <<<"${API_BODY}"
