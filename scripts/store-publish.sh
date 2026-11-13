#!/bin/bash
# Publish to the Chrome Web Store through its API.
#
#   scripts/store-publish.sh status   the store item's live and submitted revisions
#   scripts/store-publish.sh publish  build the store zip (store-zip.sh), upload it, submit it
#
# The service account's JSON key is the 1Password DEV document "Chrome Web Store API service
# account", read with op-agents into a temp folder that is removed on exit. Each upload needs
# a higher version than the store has: store-zip.sh numbers it by commits on HEAD. A submitted
# version is reviewed, then goes live by itself.
set -euo pipefail
trap 'echo "store-publish.sh: failed at line $LINENO" >&2' ERR

usage() { sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'; }

case "${1:-}" in
status | publish) COMMAND="$1" ;;
-h | --help) usage; exit 0 ;;
*) usage >&2; exit 2 ;;
esac

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
KEY_ITEM="Chrome Web Store API service account"
cd "$ROOT"

KEY_DIR="$(mktemp -d)"
trap 'rm -rf "$KEY_DIR"' EXIT
op-agents document get "$KEY_ITEM" --vault DEV --out-file "$KEY_DIR/key.json" --force >/dev/null
export CWS_SERVICE_ACCOUNT_KEY="$KEY_DIR/key.json"

if [ "$COMMAND" = status ]; then
	node scripts/store-publish.mjs status
	exit 0
fi

ZIP="$(scripts/store-zip.sh)"
node scripts/store-publish.mjs publish "$ZIP"
