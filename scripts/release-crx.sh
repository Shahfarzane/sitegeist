#!/bin/bash
# Build, sign and publish a private release to the local folder Chrome polls for updates.
#
#   scripts/release-crx.sh [ssh-host ...]
#
# 1. builds with version <major>.<minor>.<commits on HEAD> (major.minor from the source
#    manifest), so every commit on main is a higher version and nothing gets committed
# 2. signs with "sitegeist CRX signing key" from 1Password DEV, read through op-agents
# 3. copies the .crx and updates.xml to ~/.local/share/sitegeist/extension/, the folder the
#    packaged manifest's update_url points at; every ssh host given gets the same folder
#    (the file:// URL is baked into the extension, so the user path must match)
#
# First install on a Mac: install release/sitegeist-chrome-policy.mobileconfig (System
# Settings > General > Device Management), then drag the .crx onto chrome://extensions.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
UPDATE_DIR="$HOME/.local/share/sitegeist/extension"
KEY_ITEM="sitegeist CRX signing key"

cd "$ROOT"
BASE="$(node -p "require('./static/manifest.chrome.json').version.split('.').slice(0, 2).join('.')")"
VERSION="$BASE.$(git rev-list --count HEAD)"
NAME="$VERSION ($(git rev-parse --short HEAD)$( [ -n "$(git status --porcelain)" ] && echo ", modified"))"
SITEGEIST_VERSION="$VERSION" SITEGEIST_VERSION_NAME="$NAME" npm run build

KEY_DIR="$(mktemp -d)"
trap 'rm -rf "$KEY_DIR"' EXIT
op-agents document get "$KEY_ITEM" --vault DEV --out-file "$KEY_DIR/key.pem" --force >/dev/null
node scripts/pack-crx.mjs --key "$KEY_DIR/key.pem" --codebase "file://$UPDATE_DIR"
rm -rf "$KEY_DIR"

VERSION="$(node -p "require('./dist-chrome/manifest.json').version")"
CRX="sitegeist-$VERSION.crx"

publish_local() {
	mkdir -p "$UPDATE_DIR"
	cp "release/$CRX" "$UPDATE_DIR/$CRX"
	# updates.xml goes last so it never points at a .crx that is not there yet.
	cp release/updates.xml "$UPDATE_DIR/updates.xml"
	find "$UPDATE_DIR" -name 'sitegeist-*.crx' ! -name "$CRX" -delete
}

publish_remote() {
	local host="$1"
	ssh -o BatchMode=yes "$host" "mkdir -p '$UPDATE_DIR'"
	scp -q "release/$CRX" "$host:$UPDATE_DIR/$CRX"
	scp -q release/updates.xml "$host:$UPDATE_DIR/updates.xml"
	ssh -o BatchMode=yes "$host" "find '$UPDATE_DIR' -name 'sitegeist-*.crx' ! -name '$CRX' -delete"
	echo "published $VERSION to $host:$UPDATE_DIR"
}

publish_local
echo "published $VERSION to $UPDATE_DIR"
for host in "$@"; do
	publish_remote "$host"
done

# Running browsers with the extension connected update right away; the rest pick the
# release up on Chrome's own schedule (a few hours) or at the next start.
sitegeist update || true
for host in "$@"; do
	ssh -o BatchMode=yes "$host" "zsh -l -c 'sitegeist update'" || true
done

