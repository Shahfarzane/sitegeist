# Claude in Chrome parity and session performance

Work plan for closing the feature gaps against Claude in Chrome and fixing how agent sessions
are handled. Each item names the file it touches and the check that proves it. Verification runs
through `scripts/e2e/` (Chrome for Testing, throwaway profile, fake model server), never a real
browser profile or a real provider.

Out of scope by decision: scheduled tasks, approval modes, safety review, cross-device sessions.
Full access stays the default everywhere.

## Measured baseline

`scripts/e2e/bench-session.mjs`, one 1,500-token reply on a chat holding 40 screenshots (8 MB):

| Metric | Baseline |
| --- | --- |
| `sessions` store writes | 811 |
| `settings` store writes | 1,510 |
| Synchronous time inside IndexedDB `put` | 3,589 ms of a 3,657 ms stream |
| Main-thread task time | 4,302 ms |
| `sidepanel.js` | 14.2 MB (6.7 MB minified) |

Cause: the subscriber in `src/sidepanel.ts` runs on every agent event, including every streamed
token, and each run writes `lastUsedModel`, saves the whole session, and re-renders the app. All
panels of the extension share one renderer main thread, so parallel tasks slow each other down.

## Results

| Measure | Before | After |
| --- | --- | --- |
| `sessions` writes per reply | 811 | 3 |
| `settings` writes per reply | 1,510 | 1 |
| Blocking time in IndexedDB `put` | 3,589 ms | 13 ms |
| Main-thread task time per reply | 4,302 ms | about 850 ms |
| JS heap after the reply | 157 MB | 57 MB |
| Images sent per turn, 40-shot chat | 40 | at most 9 |
| `sidepanel.js` | 14.2 MB | about 7 MB |
| Rendering a 60 KB tool result | 32 s frozen | under 1 s |
| Typing 2,000 characters | 1.5 s | 40 ms |
| Form task with a real model over the bridge | 14 calls, 40.6 s | 2 calls, 18.6 s |

The form numbers compare the httpbin task in `docs/benchmarks.md` with a similar seven-field
fixture, not the same run.

## Phase 1: session handling and performance

| Item | Files | Check |
| --- | --- | --- |
| Save on message and turn boundaries, single-flight, flush on `pagehide`; write `lastUsedModel` on change; no app render per token | `src/sidepanel.ts`, new `src/storage/session-saver.ts` | bench: writes per reply drop from hundreds to a handful |
| Context manager: drop old screenshots and shrink old tool output in stepped batches so the prompt cache prefix stays stable | new `src/agent/context.ts`, `src/sidepanel.ts` | unit tests, request size on the fake server |
| Compaction: summarize older turns near the context limit and on overflow errors | `src/agent/context.ts`, `src/messages/` | e2e: a forced overflow recovers and the run continues |
| Automatic retry with backoff on rate limits and overloaded errors | new `src/agent/retry.ts` | e2e: fake server fails twice, run completes |
| Interrupted runs: record run state, offer Resume when a panel reopens on a run that died | `src/sidepanel.ts`, `src/storage/` | e2e: reload mid-run, Resume finishes the task |
| Browser session table: no lost updates between panels and the worker, no worker pass for `lastUsedAt` alone | `src/browser/session.ts`, `src/background.ts` | failing e2e first: concurrent writers keep both records |
| Minified production bundle | `scripts/build.mjs` | size check, panel still boots |
| Fewer model round trips over the bridge: `navigate` and `actions` return a page read, `actions` learns `fill`, `navigate`, `read` | `src/bridge/tools.ts`, `cli/src/mcp.ts` | e2e form task: tool calls drop |
| Long text input through `Input.insertText` | `src/browser/cdp.ts` | e2e: timing and value check |

The agent loop stays in the panel document. Moving it to an offscreen document would mean
rewriting the chat UI and REPL around a message channel; Resume covers the failure instead.

## Phase 2: full access

`allow_all` is already the default. One-time migration moves browsers that stored `ask` to
`allow_all`; `ask` stays selectable. Under `allow_all` the raw `cdp` denylist drops the entries
that only existed to protect the per-site model.

## Phase 3: notifications

| Item | Files |
| --- | --- |
| Notifications when a task finishes, fails, or needs the user, with a sound; click opens the tab. `notifications` is an optional permission: adding it as required would make Chrome disable the extension on update until someone re-approves it on every browser, taking the bridge down with it | new `src/notify/`, `static/manifest.chrome.json`, Settings |

## Phase 4: bridge tools

| Item | Files |
| --- | --- |
| `file_upload` and `upload_image`: chunked over the 1 MiB native messaging limit, file inputs, drop targets and paste | `src/bridge/tools.ts`, `src/browser/page.ts`, `cli/src/mcp.ts` |
| Panel `upload_file` tool for artifacts and attachments | new `src/tools/upload-file.ts` |
| `gif_creator`: screencast frames, click and label overlays, encoded in a worker | new `src/recording/gif*.ts`, `src/offscreen.ts` |
| Skills and saved prompts over the bridge | `src/bridge/tools.ts`, `cli/src/mcp.ts` |
| `list_connected_browsers`, `select_browser` | `cli/src/client.ts`, `cli/src/mcp.ts`, `cli/src/host.ts` |
| `resize_window` | `src/bridge/tools.ts`, `src/browser/cdp.ts` |
| `find` ranks by intent (role words, synonyms, fuzzy match) | `src/browser/find.ts` |
| Panel `read_console`, `read_network` tools | new `src/tools/devtools.ts` |

## Phase 5: connectors, 1Password, skills

| Item | Files |
| --- | --- |
| Remote MCP connectors in the panel, with headers or OAuth; tools exposed to the agent | new `src/connectors/`, Settings |
| Local stdio connectors through the native host; commands live only in a local config file, so the extension cannot spawn arbitrary programs | `cli/src/`, `src/connectors/` |
| Install Claude-format plugin folders: skills, MCP servers, commands | `src/connectors/plugins.ts`, Settings |
| General skills that are not tied to a site, and saved prompts in the `/` menu | `src/storage/stores/`, `src/sidepanel.ts` |
| 1Password sign-in: `op` through the native host with 1Password's own biometric prompt; values stay in the service worker and only fill on a matching site | `cli/src/onepassword.ts`, new `src/credentials/`, bridge and panel tools |

## Phase 6: panel additions

Region capture into the composer, site-aware suggestions on the welcome screen, right-click menu,
default skills for Slack, Gmail, Google Docs and GitHub.

## Delivery

One commit per feature, failing test first where the fix is a bug. `./check.sh` and the e2e suite
before each commit. README, `CHANGELOG.md` and `cli/README.md` updated with the code.
