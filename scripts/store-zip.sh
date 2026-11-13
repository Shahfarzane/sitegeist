#!/bin/bash
# Build the Chrome Web Store upload from the release build.
#
#   scripts/store-zip.sh                 release/store/sitegeist-<version>.zip
#   scripts/store-zip.sh --first-upload  the same zip with key.pem, in a new temp folder
#
# The version is <major>.<minor>.<commits on HEAD>, as release-crx.sh makes it, so every
# commit on main uploads as a higher version. The zip carries no `key` and no `update_url`:
# the store rejects the first and serves updates itself.
#
# --first-upload is for the item's first upload only. It adds "sitegeist CRX signing key"
# from 1Password DEV (read through op-agents) as key.pem, which makes the store item keep
# the id lnncppjiohlpejgcbdgoihplimdckddn. That zip holds the private key: it is written
# outside the repo, and the folder it prints is deleted once the upload is done.
#
# Prints the zip's path on stdout; build output goes to stderr.
set -euo pipefail
trap 'echo "store-zip.sh: failed at line $LINENO" >&2' ERR

usage() { sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'; }

FIRST_UPLOAD=""
for arg in "$@"; do
	case "$arg" in
	--first-upload) FIRST_UPLOAD=1 ;;
	-h | --help) usage; exit 0 ;;
	*) echo "store-zip.sh: unknown argument: $arg" >&2; usage >&2; exit 2 ;;
	esac
done

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
KEY_ITEM="sitegeist CRX signing key"
cd "$ROOT"

BASE="$(node -p "require('./static/manifest.chrome.json').version.split('.').slice(0, 2).join('.')")"
VERSION="$BASE.$(git rev-list --count HEAD)"
MODIFIED=""
if [ -n "$(git status --porcelain)" ]; then MODIFIED=", modified"; fi
NAME="$VERSION ($(git rev-parse --short HEAD)$MODIFIED)"
SITEGEIST_VERSION="$VERSION" SITEGEIST_VERSION_NAME="$NAME" npm run build >&2

if [ -z "$FIRST_UPLOAD" ]; then
	node scripts/pack-crx.mjs --store --out release/store
	exit 0
fi

OUT_DIR="$(mktemp -d "${TMPDIR:-/tmp}/sitegeist-store.XXXXXX")"
KEY_DIR="$(mktemp -d)"
trap 'rm -rf "$KEY_DIR"' EXIT
op-agents document get "$KEY_ITEM" --vault DEV --out-file "$KEY_DIR/key.pem" --force >/dev/null
node scripts/pack-crx.mjs --store --include-key "$KEY_DIR/key.pem" --out "$OUT_DIR"
echo "store-zip.sh: this zip holds the private key; delete $OUT_DIR after the upload" >&2
