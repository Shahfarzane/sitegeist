# CDP review: work plan

Implements `docs/cdp-review.md` (review of Chrome 141 to 158, written 2026-11-07). Each item was re-checked before work started, in Chrome for Testing 157 with the real extension build (`scripts/e2e/` harness) or against the code. Where the check contradicts the review, the column says so and the plan follows the check.

## Re-check results that change the review

- 1.1: `Runtime.terminateExecution` is refused for extensions ("not allowed for untrusted clients"), so the review's fix fails, and the existing debugger-path cancel never worked either. What works: `Runtime.evaluate` with `timeout` stops a busy loop, and `chrome.tabs.discard` frees a tab whose main thread is stuck. Cancel now rejects at once and frees a stuck tab.
- 1.2: confirmed. After "Allow User Scripts" is revoked, `execute` stays a function and `getScripts()` throws "is not available in this context".
- 1.9: not reproduced. A plain mouse drag of a `draggable` element still delivers `drop` on 157 (`dragstart, pointercancel, drop`). No change.
- APIs confirmed present on 157: `tabs.createSplit`, `Tab.splitViewId`, `sidePanel.close`, `onOpened`, `onClosed`, `runtime.onExtensionLoaded`, the `tab` menu context, `Log.enable`, `WebMCP.enable`, `Page.setInputVisualization`, `scrollbarType`.

## Items

| Item | Decision | PR |
|---|---|---|
| 1.1 REPL cancel | Fix (reject on abort, free a stuck tab, drop the `terminate` probe) | 1 |
| 1.2 Revoked user scripts toggle | Fix (`getScripts()` check, CDP fallback on error, capability report) | 1 |
| 1.3 Viewport after detach | Fix (clear before detach) and raise `minimum_chrome_version` to 154 | 1 |
| 1.4 Policy attach errors | Fix (name the policy) | 1 |
| 1.5 Deny list names | Fix | 1 |
| 1.6 Chrome for Testing host folder | Fix | 1 |
| 1.7 Split view visibility | Fix | 1 |
| 1.8 HTTPS warning page | Fix after a probe of how it shows | 1 |
| 1.9 Drag cancels pointer events | No change (not reproduced) | none |
| 1.10 Back/forward cache restore | Fix for the screencast init script | 1 |
| 1.11 Local network prompts | Document in the REPL description | 1 |
| 2.1 Cmd shortcuts on macOS | Build | 2 |
| 2.2 Screencast frame cap | Build | 2 |
| 2.3 Page dialogs | Build | 2 |
| 2.6 Video recording | Build | 2 |
| 2.11 Viewport emulation fields | Build | 2 |
| 2.12 Click markers | Build | 2 |
| 2.4 File upload through CDP | Build | 3 |
| 2.7 Isolated world for the debugger path | Build | 3 |
| 2.8 Log domain | Build | 3 |
| 2.9 Network response bodies | Build | 3 |
| 2.10 Cross-origin iframes | Build | 3 |
| 2.5 Side panel close and events | Build | 4 |
| 2.13 Small API additions | Build | 4 |
| 2.14 WebMCP tools | Build | 4 |
| 2.15 Annotated page content | Decide after a probe | 4 |
| 2.16 Agent tab in split view | Build | 4 |
| 3.9 Optional `downloads` | Build | 4 |
| 3.2, 3.3, 3.4 Policy profile | Build | 5 |
| 3.8 Background tab freezing | Check freezing first, then code-side fix | 5 |
| 3.6 Debugger on `chrome://` | Code allows it when the browser does; the Helium flag stays his call | 5 |
| 3.1 File URL access toggle | One click per browser, after PR 3 | rollout |
| 3.5 Debugger infobar in Chrome | Not possible without MDM; a launch flag does not persist | none |
| 3.7 User scripts toggle policy | Nothing exists to set | none |

## Progress

Updated as each PR lands.
