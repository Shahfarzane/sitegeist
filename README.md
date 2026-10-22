<p align="center">
  <img src="media/hero.png" alt="Sitegeist" width="400">
</p>

An AI assistant that lives in your browser sidebar, and a bridge that lets coding agents
use your browser too. Built for collaboration, not autonomy theater. You guide, it executes.

Sitegeist automates repetitive web tasks, extracts data from any website, navigates across
pages, fills out forms, compiles research, and turns what it finds into documents,
spreadsheets, or whatever you need. It works on any website through a Chromium side panel
(Chrome, Brave, Edge, Arc, Vivaldi, Opera, Chromium), using the AI provider of your choice.

Bring your own API key or log in with an existing subscription (Anthropic Claude,
OpenAI/ChatGPT, GitHub Copilot, Google Gemini). Your data stays on your machine. Nothing
is collected or tracked.

This fork (0xSero/sitegeist) adds three things to upstream (badlogic/sitegeist):
1. **Background operation.** Every chat owns its own tab group. Tabs open inactive, the
   agent acts on its own current tab, and it never sees or touches your other tabs.
2. **Per-tab panels for parallel tasks.** The panel is bound to a tab, not a window (the
   Claude-in-Chrome model): each task lives on the tab you opened it on, and a tab shows
   the panel only when a task owns it. Run several tasks at once, one per tab, and put
   two tabs in two windows to watch both side by side.
3. **Dynamic model lists.** Models are fetched from the connected providers at runtime
   instead of a hardcoded table.
4. **A harness bridge.** Claude Code, Codex, omp, pi, or any MCP client can drive the
   browser through Sitegeist, in the background, with no configuration.

## Install the extension

This fork ships as a self-signed `.crx` (extension id
`lnncppjiohlpejgcbdgoihplimdckddn`). The signing key is "sitegeist CRX signing key" in
1Password DEV; `static/manifest.chrome.json` carries its public half, so unpacked builds
and signed releases install under the same id.
1. Prepare the sibling repos once per machine: `scripts/setup-siblings.sh`.
2. Build, sign and publish: `scripts/release-crx.sh` (append ssh hosts, e.g. `m3`, to
   publish there too). It writes the `.crx` and `updates.xml` to
   `~/.local/share/sitegeist/extension/`, the `file://` update URL baked into the release.
   The version is `<major>.<minor>.<commits on HEAD>`, so nothing needs committing.
3. First time on a Mac: open `release/sitegeist-chrome-policy.mobileconfig` and install it
   in System Settings > General > Device Management. It puts the id on Chrome's
   `ExtensionInstallAllowlist`; without it, Google Chrome on macOS disables off-store
   extensions. Restart Chrome and check `chrome://policy`.
4. Open `chrome://extensions`, enable Developer mode, and drag
   `~/.local/share/sitegeist/extension/sitegeist-<version>.crx` onto the page.
5. Open the side panel with `Cmd+Shift+S` / `Ctrl+Shift+S` and connect a provider.

Later releases are automatic: `scripts/install-auto-release.sh m3` installs a launchd agent
that runs `scripts/auto-release.sh` every 10 minutes. When `origin/main` moves it builds
the new commit (only from a clean `main` checkout), signs, publishes here and to each ssh
host (retrying hosts that are asleep), and ends with `sitegeist update`, which makes every
running browser with the extension connected reload into the new version. Browsers that are
closed pick it up on Chrome's own schedule. Log: `~/Library/Logs/sitegeist-auto-release.log`.
To start a new minor line, change the first two numbers of the version in
`static/manifest.chrome.json`.

For development, `npm run build` and Load unpacked `dist-chrome/` work as before and
replace the installed release (same id, same data).

No toggles are required. In-page JavaScript runs through the `userScripts` API when the
browser exposes it (an isolated world whose CSP blocks network access from injected code)
and through the debugger's `Runtime.evaluate` otherwise (the page's main world; Chrome
shows its "is debugging this browser" bar). If you want the stricter sandbox, enable
**Allow user scripts** in the extension's details; everything works either way.

Requires Chrome 141+ or the equivalent Chromium release.

## Use it from a coding agent

```bash
cd cli && npm install && npm run build && npm link   # until published to npm
sitegeist install                                     # native-messaging manifest for every Chromium browser found
claude mcp add --scope user sitegeist -- /opt/homebrew/opt/node@24/bin/node /opt/homebrew/bin/sitegeist mcp   # Claude Code (install prints the exact paths)
sitegeist pi-extension                                # pi: writes ~/.pi/agent/extensions/sitegeist.ts
sitegeist status                                      # is the extension reachable?
```

Codex, in `~/.codex/config.toml`:

```toml
[mcp_servers.sitegeist]
command = "sitegeist"
args = ["mcp"]
```

omp: add an MCP server entry that runs `sitegeist mcp`.

`sitegeist mcp` installs the manifest itself on first run, so the only manual step is
loading the extension once. Reload the extension after the first install.

How it is wired, and why it is safe:

```
harness ── stdio MCP ── sitegeist mcp ── unix socket ── native host ── native messaging ── extension
```

The browser spawns the native host. The host owns a socket in
`/tmp/sitegeist-bridge-<user>/` (0700 directory, 0600 socket) that only your user can
reach, and it only relays frames; all logic and all permission checks live in the
extension. Nothing listens on the network. Each harness gets its own tab group
("Sitegeist · claude", "Sitegeist · pi") and works in the background; `tabs_show` is the
only tool that changes what you see.

Site access: by default agents may open any site. To be asked first, switch Settings >
Bridge to "Ask before opening a new site" or run `sitegeist ask` (`sitegeist yolo` switches
back). In that mode Claude Code and Codex show the prompt inline (MCP elicitation);
otherwise answer it in the side panel under Settings > Bridge or run `sitegeist allow <host>`.

Provider logins: when Claude Code or Codex is logged in on this computer, the Anthropic and
ChatGPT providers use that login, so they need no setup. The native host reads Claude Code's
Keychain entry (or `~/.claude/.credentials.json`) and `~/.codex/auth.json` and hands the
extension the access token only. Claude Code's login is read only: after 8 idle hours its
token has expired until `claude` runs again. Codex's login is refreshed by the host when it
expires and written back to `auth.json`, so Codex stays logged in. Logout under Settings >
Providers stops sitegeist from using a CLI login; "Use Claude Code" / "Use Codex" turns it
back on.

CLI commands: `mcp`, `install`, `status`, `allow <host>`, `reload`, `debug`,
`pi-extension`. See `cli/README.md`.

## What changed in this fork

Extension:
- `src/browser/` is new and is the only code that touches tabs: `session.ts` (tab group
  per session, current tab, persistence in `chrome.storage.session`), `cdp.ts`
  (`chrome.debugger` screenshots, real input events, focus emulation so hidden tabs keep
  running `requestAnimationFrame` and lazy loading), `page.ts` (navigation with load
  wait, in-page scripts with `userScripts` → `scripting` → CDP fallbacks, snapshot with
  element refs), `foreground-guard.ts` (popups opened by agent tabs no longer steal
  focus).
- Every tool now acts on the session's current tab instead of the active tab:
  `navigate` (new `showTab`, `closeTab`, `back`/`forward`; `switchToTab` no longer
  focuses), `browserjs()`, native input events, debugger, skills, element picker,
  `extract_image` (CDP screenshot instead of `captureVisibleTab`).
- Opening the side panel puts the tab you opened it on into the session's tab group
  right away, so the group exists from the start. The side panel only reacts to URL
  changes on its own tabs. A link icon in the header shares further tabs with the agent.
- `src/models/`: runtime model discovery for Anthropic, OpenAI, ChatGPT/Codex, Gemini,
  GitHub Copilot, OpenRouter, Mistral, Groq, xAI, Cerebras, Hugging Face; metadata from
  the generated table and models.dev; cached in IndexedDB (`discovered-models` store).
  Providers without a list endpoint keep the static table. `registerModels` was added to
  `pi-ai` (`../pi-mono/packages/ai/src/models.ts`).
- `src/bridge/`: native messaging port, one browser session per connected harness,
  request routing, site permissions, diagnostics (`bridge.debug`, `bridge.bench`,
  `bridge.reload`). Settings gained a Bridge tab.
- Manifest: fixed `key` (stable id `lnncppjiohlpejgcbdgoihplimdckddn`), new permissions
  `tabGroups`, `nativeMessaging`, `alarms`.
- Fixed the type errors in the custom provider dialogs.

CLI (`cli/`, package `sitegeist`): native host, socket client, MCP server with 24 tools (including raw `cdp`),
installer for all Chromium browser directories (macOS, Linux, Windows registry), pi
extension generator.

Design and evidence (reference implementations, experiments, protocol): see
`docs/agent-bridge-design.md`. Live task results and bridge latencies: `docs/benchmarks.md`.
Full list of changes: `CHANGELOG.md`.

## Development

The extension builds against two sibling repos in the same parent directory. The workspace
repo holds all three as submodules:

```
sitegeist-workspace/   # https://github.com/Shahfarzane/sitegeist-workspace
  sitegeist/           # this repo
  mini-lit/            # https://github.com/Shahfarzane/mini-lit, branch sitegeist (badlogic/mini-lit v0.2.1 + changes)
  pi-mono/             # https://github.com/Shahfarzane/pi-mono, branch sitegeist (earendil-works/pi v0.60.0 + changes)
```

```bash
git clone --recurse-submodules https://github.com/Shahfarzane/sitegeist-workspace.git
cd sitegeist-workspace/sitegeist
scripts/setup-siblings.sh      # installs everything, builds mini-lit, pi-mono declarations, the CLI
```

Sibling changes are commits on the forks' `sitegeist` branch. After committing and pushing
one, run `scripts/sibling-patches.sh export` and commit the updated `patches/` here; the
pre-commit check fails while they differ. The patches let `scripts/setup-siblings.sh`
rebuild the siblings from the public upstream tags where the forks are not available (CI,
a fresh machine without GitHub access): it clones the tag and applies the patch. pi-mono
must stay on v0.60.0: upstream main renamed the packages to `@earendil-works/*` and dropped
web-ui.

Start all dev watchers (mini-lit, pi-mono, sitegeist extension, marketing site):

```bash
./dev.sh
```

The patch adds pi-mono APIs that upstream never published. In
`../pi-mono/packages/ai/src/models.ts` (runtime model discovery registers into its model
registry):

```ts
export function registerModels(provider: string, models: Model<Api>[]): void {
	const providerModels = new Map<string, Model<Api>>();
	for (const model of models) providerModels.set(model.id, model);
	modelRegistry.set(provider, providerModels);
}

export function resetProviderModels(provider: string): void {
	const generated = (MODELS as Record<string, Record<string, Model<Api>>>)[provider];
	if (!generated) {
		modelRegistry.delete(provider);
		return;
	}
	const providerModels = new Map<string, Model<Api>>();
	for (const [id, model] of Object.entries(generated)) providerModels.set(id, model);
	modelRegistry.set(provider, providerModels);
}

export function getGeneratedModels(provider: string): Model<Api>[] {
	const generated = (MODELS as Record<string, Record<string, Model<Api>>>)[provider];
	return generated ? Object.values(generated) : [];
}
```

The composer tweaks (ArrowUp prompt recall via `historyProvider`, plain model-id button,
arrow send button) live in `../pi-mono/packages/web-ui/src/components/MessageEditor.ts`
and `AgentInterface.ts`; the sitegeist side only sets `agentInterface.historyProvider`.

Rebuild the extension and reload it from the terminal:

```bash
npm run build && sitegeist reload
```

Note: a production build bumps the version in `static/manifest.chrome.json`.

## Checks

```bash
./check.sh        # biome + tsc for the extension and the site
(cd cli && npm run check)
```

The Husky pre-commit hook runs `./check.sh`.

## Updating the website

```bash
cd site && ./run.sh deploy
```

Builds the static site and uploads it to `sitegeist.ai`. Requires SSH access to
`slayer.marioslab.io`.

## Releasing

```bash
./release.sh patch   # 1.0.0 -> 1.0.1
./release.sh minor   # 1.0.0 -> 1.1.0
./release.sh major   # 1.0.0 -> 2.0.0
```

Bumps the version in `static/manifest.chrome.json`, commits, tags, and pushes. GitHub
Actions builds the extension and creates a release with the unpacked zip (no signing key in
CI). For the signed `.crx`, use `scripts/release-crx.sh` (see Install the extension).

## License

AGPL-3.0. See [LICENSE](LICENSE). Upstream: [badlogic/sitegeist](https://github.com/badlogic/sitegeist).
