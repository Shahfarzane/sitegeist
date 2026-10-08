#!/bin/bash
# Keep patches/ in sync with the sibling forks (Shahfarzane/mini-lit, Shahfarzane/pi-mono).
#
#   scripts/sibling-patches.sh export   regenerate patches/ from the forks' committed HEAD
#   scripts/sibling-patches.sh check    fail if patches/ differs from the forks (pre-commit)
#
# Edit sibling code in ../mini-lit or ../pi-mono, commit and push it there, then export and
# commit the patches here. `check` skips a sibling that is a plain upstream clone with the
# patch applied (its HEAD is the upstream tag), which is how CI and fresh setups look.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PARENT="$(dirname "$ROOT")"
# shellcheck source=siblings.conf
source "$ROOT/scripts/siblings.conf"

mini_lit_diff() { git -C "$PARENT/mini-lit" diff "$MINI_LIT_TAG" HEAD -- src; }
pi_diff() { git -C "$PARENT/pi-mono" diff "$PI_TAG" HEAD -- . ':(exclude)package-lock.json' ':(exclude)**/package-lock.json'; }

# A fork checkout has commits on top of the tag; a patched upstream clone does not.
is_fork() { [ -d "$PARENT/$1/.git" ] || [ -f "$PARENT/$1/.git" ] && [ "$(git -C "$PARENT/$1" rev-parse HEAD)" != "$(git -C "$PARENT/$1" rev-parse "$2^{commit}")" ]; }

mode="${1:-}"
status=0
for sibling in mini-lit pi-mono; do
	if [ "$sibling" = mini-lit ]; then tag="$MINI_LIT_TAG" patch="$ROOT/patches/mini-lit-$MINI_LIT_TAG-sitegeist.patch" gen=mini_lit_diff
	else tag="$PI_TAG" patch="$ROOT/patches/pi-mono-$PI_TAG-sitegeist.patch" gen=pi_diff; fi
	if ! is_fork "$sibling" "$tag" 2>/dev/null; then
		[ "$mode" = export ] && { echo "../$sibling is not a fork checkout with commits on $tag" >&2; exit 1; }
		continue
	fi
	case "$mode" in
		export)
			"$gen" >"$patch"
			echo "wrote ${patch#"$ROOT/"}"
			;;
		check)
			if ! cmp -s <("$gen") "$patch"; then
				echo "${patch#"$ROOT/"} does not match ../$sibling HEAD; run scripts/sibling-patches.sh export" >&2
				status=1
			fi
			;;
		*)
			echo "usage: $0 export|check" >&2
			exit 2
			;;
	esac
done
exit "$status"
