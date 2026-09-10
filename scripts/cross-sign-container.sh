#!/bin/bash
# Cross-sign the device belonging to a containerised deployment.
#
#   scripts/cross-sign-container.sh ~/containers/bk18pi2
#
# The image cannot do this itself: cross-signing needs matrix-js-sdk, which is
# a devDependency and so absent from an image built with `npm ci --omit=dev`.
# That is fine, because scripts/cross-sign.js was already built to stand apart
# — it logs in as a throwaway device and never opens the bot's crypto store.
# So it runs from this repo, pointed at the deployment's directory.
#
# What it does not do is guess. It takes the device id from the deployment's
# own token.json and the credentials from its own .env, and refuses if the two
# disagree — signing a device with another account's credentials is the
# mistake worth making impossible.

set -euo pipefail

DEPLOY="${1:-}"
if [ -z "$DEPLOY" ]; then
  echo "usage: $0 <deployment-dir>   # the directory holding compose.yml, .env and data/" >&2
  exit 2
fi

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TOKEN="$DEPLOY/data/token.json"
ENVFILE="$DEPLOY/.env"

[ -f "$TOKEN" ]   || { echo "no $TOKEN — has the bot logged in yet?" >&2; exit 3; }
[ -f "$ENVFILE" ] || { echo "no $ENVFILE" >&2; exit 3; }

# sed rather than sourcing: a recovery key contains spaces, so `. .env` would
# try to run the second word as a command.
read_env() { sed -n "s/^$1=//p" "$ENVFILE" | head -1; }

DEVICE="$(node -e 'console.log(JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8")).deviceId)' "$TOKEN")"
OWNER="$(node -e 'console.log(JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8")).userId)' "$TOKEN")"
USER_ID="$(read_env MATRIX_USER_ID)"
PASSWORD="$(read_env MATRIX_PASSWORD)"
RECOVERY="$(read_env MATRIX_RECOVERY_KEY)"

# The guard that matters. Credentials get copied between deployments, and
# signing with the wrong account's key is not a failure you want to debug from
# the other side.
if [ "$USER_ID" != "$OWNER" ]; then
  echo "refusing: $ENVFILE is for $USER_ID but $TOKEN belongs to $OWNER" >&2
  exit 4
fi
[ -n "$PASSWORD" ] || { echo "refusing: MATRIX_PASSWORD is empty in $ENVFILE — a fresh login is needed to sign" >&2; exit 5; }
[ -n "$RECOVERY" ] || { echo "refusing: MATRIX_RECOVERY_KEY is empty in $ENVFILE — secret storage cannot be unlocked" >&2; exit 5; }

echo "signing device $DEVICE for $OWNER"
echo "  deployment : $DEPLOY"
echo "  using      : $REPO/scripts/cross-sign.js"

if [ "${DRY_RUN:-}" = "1" ]; then
  echo "  DRY_RUN=1, stopping before the login"
  exit 0
fi

cd "$REPO"
MATRIX_USER_ID="$USER_ID" \
MATRIX_PASSWORD="$PASSWORD" \
MATRIX_RECOVERY_KEY="$RECOVERY" \
  npm run cross-sign -- "$DEVICE"
