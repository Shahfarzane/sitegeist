#!/bin/bash
# Clone and prepare the sibling repos the extension builds against:
#   ../mini-lit  badlogic/mini-lit at v0.2.1 + patches/mini-lit-v0.2.1-sitegeist.patch
#   ../pi-mono   earendil-works/pi at v0.60.0 + patches/pi-mono-v0.60.0-sitegeist.patch
# The patch adds pi-mono APIs that were never published upstream (registerModels and
# friends in pi-ai, ModelSelector/MessageEditor/AgentInterface hooks in pi-web-ui).
# Do not move pi-mono to upstream main: it renamed the packages and dropped web-ui.
# The mini-lit patch makes dialogs full-height sheets in narrow viewports (the side panel).
# Safe to re-run: existing clones are reused and each patch is applied only once.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PARENT="$(dirname "$ROOT")"
MINI_LIT_TAG=v0.2.1
PI_TAG=v0.60.0

# npm 12 refuses URL tarball dependencies (xlsx from cdn.sheetjs.com) unless allowed.
NPM_INSTALL=(npm install)
if [ "$(npm -v | cut -d. -f1)" -ge 12 ]; then
	NPM_INSTALL+=(--allow-remote=root)
fi

if [ ! -d "$PARENT/mini-lit" ]; then
	git clone --branch "$MINI_LIT_TAG" https://github.com/badlogic/mini-lit.git "$PARENT/mini-lit"
	git -C "$PARENT/mini-lit" switch -c sitegeist
fi

if [ ! -d "$PARENT/pi-mono" ]; then
	git clone --filter=blob:none --branch "$PI_TAG" https://github.com/earendil-works/pi.git "$PARENT/pi-mono"
	git -C "$PARENT/pi-mono" switch -c sitegeist
fi

apply_once() {
	local repo="$1" patch="$2"
	if git -C "$repo" apply --reverse --check "$patch" 2>/dev/null; then
		echo "$(basename "$patch") already applied"
	else
		git -C "$repo" apply "$patch"
		echo "$(basename "$patch") applied"
	fi
}
apply_once "$PARENT/mini-lit" "$ROOT/patches/mini-lit-v0.2.1-sitegeist.patch"
apply_once "$PARENT/pi-mono" "$ROOT/patches/pi-mono-v0.60.0-sitegeist.patch"

(cd "$PARENT/mini-lit" && "${NPM_INSTALL[@]}" && npm run build)
(cd "$PARENT/pi-mono" && "${NPM_INSTALL[@]}")

# esbuild bundles pi-mono from src/; tsc needs the declarations for typechecking.
for pkg in ai agent web-ui; do
	(cd "$PARENT/pi-mono/packages/$pkg" && ../../node_modules/.bin/tsc -p tsconfig.build.json)
done
(cd "$PARENT/pi-mono/packages/web-ui" && ../../node_modules/.bin/tailwindcss -i ./src/app.css -o ./dist/app.css --minify)

(cd "$ROOT" && "${NPM_INSTALL[@]}")

echo "Siblings ready. Build with: npm run build"
