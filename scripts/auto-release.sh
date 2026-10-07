#!/bin/bash
# Publish a signed release whenever origin/main moves. Run by launchd every 10 minutes
# (scripts/install-auto-release.sh); safe to run by hand.
#
#   scripts/auto-release.sh [ssh-host ...]
#
# - builds only a clean checkout of main that can fast-forward to origin/main, so work in
#   progress is never touched; otherwise it logs and waits for the next run
# - reruns setup-siblings.sh when the patches or dependencies changed since the last release
# - release-crx.sh signs, publishes to ~/.local/share/sitegeist/extension and nudges running
#   browsers; each ssh host gets the same files, and a host that is asleep is retried on the
#   next run without rebuilding
set -euo pipefail
trap 'echo "$(date "+%F %T") auto-release.sh: failed at line $LINENO" >&2' ERR

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STATE_DIR="$HOME/.local/share/sitegeist"
UPDATE_DIR="$STATE_DIR/extension"

log() { echo "$(date '+%F %T') $*"; }

cd "$ROOT"
git fetch -q origin main
target="$(git rev-parse origin/main)"
released="$(cat "$STATE_DIR/released-commit" 2>/dev/null || true)"

if [ "$released" != "$target" ]; then
	branch="$(git rev-parse --abbrev-ref HEAD)"
	if [ "$branch" != main ] || [ -n "$(git status --porcelain)" ] || ! git merge-base --is-ancestor HEAD origin/main; then
		log "checkout is not a clean main that can fast-forward ($branch); skipping ${target:0:7}"
		exit 0
	fi
	git merge -q --ff-only origin/main
	if [ -z "$released" ] || ! git diff --quiet "$released" "$target" -- patches package.json package-lock.json scripts/setup-siblings.sh; then
		./scripts/setup-siblings.sh
	fi
	./scripts/release-crx.sh
	mkdir -p "$STATE_DIR"
	echo "$target" >"$STATE_DIR/released-commit"
	log "released ${target:0:7}"
fi

# Hosts track what was released here, not origin/main: a skipped build must not mark them done.
current="$(cat "$STATE_DIR/released-commit" 2>/dev/null || true)"
[ -n "$current" ] || exit 0
for host in "$@"; do
	[ "$(cat "$STATE_DIR/released-commit-$host" 2>/dev/null || true)" = "$current" ] && continue
	crx="$(cd "$UPDATE_DIR" && ls sitegeist-*.crx)"
	if ssh -o BatchMode=yes -o ConnectTimeout=5 "$host" "mkdir -p '$UPDATE_DIR'" &&
		scp -q "$UPDATE_DIR/$crx" "$host:$UPDATE_DIR/$crx" &&
		scp -q "$UPDATE_DIR/updates.xml" "$host:$UPDATE_DIR/updates.xml" &&
		ssh -o BatchMode=yes "$host" "find '$UPDATE_DIR' -name 'sitegeist-*.crx' ! -name '$crx' -delete"; then
		ssh -o BatchMode=yes "$host" "zsh -l -c 'sitegeist update'" || true
		echo "$current" >"$STATE_DIR/released-commit-$host"
		log "published $crx to $host"
	else
		log "$host unreachable; retrying on the next run"
	fi
done
