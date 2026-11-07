# CDP review: work plan

Implements `docs/cdp-review.md` (review of Chrome 141 to 158, written 2026-11-07). Each item was re-checked before work started, in Chrome for Testing 157 with the real extension build (`scripts/e2e/` harness) or against the code. Where the check contradicts the review, the column says so and the plan follows the check.

## Re-check results that change the review

- 1.1: `Runtime.terminateExecution` is refused for extensions ("not allowed for untrusted clients"), so the review's fix fails, and the existing debugger-path cancel never worked either. What works: `Runtime.evaluate` with `timeout` stops a busy loop, and `chrome.tabs.discard` frees a tab whose main thread is stuck. Cancel now rejects at once and frees a stuck tab.
- 1.2: confirmed. After "Allow User Scripts" is revoked, `execute` stays a function and `getScripts()` throws "is not available in this context".
- 1.9: not reproduced. A plain mouse drag of a `draggable` element still delivers `drop` on 157 (`dragstart, pointercancel, drop`). No change.
- APIs confirmed present on 157: `tabs.createSplit`, `Tab.splitViewId`, `sidePanel.close`, `onOpened`, `onClosed`, `runtime.onExtensionLoaded`, the `tab` menu context, `Log.enable`, `WebMCP.enable`, `Page.setInputVisualization`, `scrollbarType`.

## Items

| Item | Outcome | PR |
|---|---|---|
| 1.1 REPL cancel | Fixed: reject on abort, reload a tab the script still blocks (the review's fix is refused by Chrome) | #27 |
| 1.2 Revoked user scripts toggle | Fixed | #27 |
| 1.3 Viewport after detach | Fixed; `minimum_chrome_version` 154 | #27 |
| 1.4 Policy attach errors | Fixed | #27 |
| 1.5 Deny list names | Kept with a note (deprecated names still work) | #27 |
| 1.6 Chrome for Testing host folder | Fixed | #27 |
| 1.7 Split view visibility | Fixed | #27 |
| 1.8 HTTPS warning page | Fixed (Chrome reports it as `ERR_BLOCKED_BY_CLIENT`) | #27 |
| 1.9 Drag cancels pointer events | No change: not reproduced on 157 | none |
| 1.10 Back/forward cache restore | Fixed for the screencast init script | #27 |
| 1.11 Local network prompts | Documented in the REPL description | #27 |
| 2.1 Cmd shortcuts on macOS | Built | #28 |
| 2.2 Screencast frame cap | Built | #28 |
| 2.3 Page dialogs | Built, with `handle_dialog` | #28 |
| 2.6 Video recording | Built (`record_video`, bridge only) | #28 |
| 2.11 Viewport emulation fields | `scrollbarType: "overlay"`; `viewportMeta` and `textLayoutMode` have no use outside `mobile`, which already sets both | #28 |
| 2.12 Click markers | Built for live views | #28 |
| 2.4 File upload through CDP | Built (`upload.paths`), page-script fallback kept | #29 |
| 2.7 Isolated world for the debugger path | Built | #29 |
| 2.8 Log domain | Built | #29 |
| 2.9 Network response bodies | Built | #29 |
| 2.10 Cross-origin iframes | Built (`run_js` `frame`) | #29 |
| 2.5 Side panel close and events | Shortcut toggles with `sidePanel.close` | #30 |
| 2.13 Small API additions | Tab menu and `onExtensionLoaded` built. Structured clone: no gain (frames arrive base64 from CDP). Syntax check: the claim fails (`execute()` returns `null` with no error), so a `null` result is now an error | #30 |
| 2.14 WebMCP tools | Not built: `navigator.modelContext` does not exist on 157, so no page can register tools | none |
| 2.15 Annotated page content | Not built: undocumented protobuf with the same text as `read_page`; the `cdp` tool can call it | none |
| 2.16 Agent tab in split view | Not built: a split needs both tabs in one group, and leaving the session group hands the tab back | none |
| 3.9 Optional `downloads` | Built: Settings > Downloads, `list_downloads` | #30 |
| 3.2, 3.4 Policy profile | Built: per-id `ExtensionSettings` (toolbar pin, `file://` navigation) for Chrome and a `net.imput.helium` payload | #31 |
| 3.3 Install sources | No change: the profile already lists the `file://` release folder | none |
| 3.8 Background tab freezing | No change: no tab froze in 5.5 minutes (control included), and a freeze cannot be simulated in a way that sets `tab.frozen`. Found instead: agent tabs get the same background timer throttling as plain tabs (63 ticks of a 1 s interval in 330 s) | none |
| 3.6 Debugger on `chrome://` | Not built: with `--extensions-on-chrome-urls`, attaching to `chrome://version` is still refused in Chrome for Testing 157 and in Helium 157 | none |
| 3.1 File URL access toggle | One click per browser (rollout) | none |
| 3.5 Debugger infobar in Chrome | Not possible without MDM; a launch flag does not persist | none |
| 3.7 User scripts toggle policy | Nothing exists to set | none |

## Rollout

- Install the regenerated `release/sitegeist-chrome-policy.mobileconfig` on each Mac (it replaces the old one) and restart Chrome and Helium.
- Turn on "Allow access to file URLs" for sitegeist in each browser's extension details, for the Chrome upload path.
