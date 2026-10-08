#!/bin/bash
# Install (or reinstall) the launchd agent that runs scripts/auto-release.sh every 10 minutes.
#
#   scripts/install-auto-release.sh [ssh-host ...]     e.g. scripts/install-auto-release.sh m3
#   scripts/install-auto-release.sh --uninstall
#
# Log: ~/Library/Logs/sitegeist-auto-release.log
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LABEL="com.shahfarzane.sitegeist-auto-release"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$HOME/Library/Logs/sitegeist-auto-release.log"
DOMAIN="gui/$(id -u)"

launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
if [ "${1:-}" = "--uninstall" ]; then
	rm -f "$PLIST"
	echo "removed $LABEL"
	exit 0
fi

args="<string>$ROOT/scripts/auto-release.sh</string>"
for host in "$@"; do
	args="$args
		<string>$host</string>"
done

# Standard priority: Background pins the job to efficiency cores with throttled I/O, which
# stretched a 20-second build to half an hour. Releases are short and only run when main moves.
# launchd starts jobs with a minimal PATH: node and npm (Homebrew node@24), git, ssh,
# op-agents (~/.local/bin, signing key from 1Password) and the sitegeist CLI must resolve.
cat >"$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>$LABEL</string>
	<key>ProgramArguments</key>
	<array>
		<string>/bin/bash</string>
		$args
	</array>
	<key>EnvironmentVariables</key>
	<dict>
		<key>PATH</key>
		<string>/opt/homebrew/opt/node@24/bin:/opt/homebrew/bin:$HOME/.local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
	</dict>
	<key>StartInterval</key>
	<integer>600</integer>
	<key>RunAtLoad</key>
	<true/>
	<key>ProcessType</key>
	<string>Standard</string>
	<key>StandardOutPath</key>
	<string>$LOG</string>
	<key>StandardErrorPath</key>
	<string>$LOG</string>
</dict>
</plist>
EOF
plutil -lint "$PLIST" >/dev/null
launchctl bootstrap "$DOMAIN" "$PLIST"
echo "installed $LABEL (every 10 minutes, log: $LOG)"
