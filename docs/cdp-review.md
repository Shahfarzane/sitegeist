# CDP and Chrome extension review

Review date 2026-11-07. Covers what changed in the Chrome DevTools Protocol and the extension platform from Chrome 141 (sitegeist's `minimum_chrome_version`) to current stable, and what sitegeist should do about it.

Versions on that date: Chrome 157 is stable (2026-11-03), 158 is in early stable at 0.5% and goes to everyone on 2026-11-17, and 159 follows on 2026-12-08. Chrome has shipped a stable every two weeks since 153. Helium 0.21.1.1 is built on Chromium 157.0.8103.38. The protocol tip of tree is r1734725 (2026-11-04).

Code references are `file:line` in sitegeist at `aeec4fb`, the commit this workspace pins, written relative to this repo (`sitegeist/src/...`).

## How claims were checked

Every item carries one of three labels, and each section lists verified items before inferred ones.

- Verified by probe: reproduced on headless Chrome for Testing 157 on macOS, driven over raw CDP with a throwaway profile. That is a trusted client, so where extension clients get less, the item says so and cites the Chromium check.
- Verified in source: read in the Chrome docs, the protocol JSON, or Chromium source at `main` (and the 141 tag where the item compares), plus the sitegeist code it affects.
- Inferred: reasoning from the above that no doc states and no probe tested.

Two Chromium facts recur below. First, `chrome.debugger` clients are untrusted. Content gives them only the Audits, DOM, Debugger, DeviceOrientation, Emulation, Input, Inspector, IO, Overlay, Network, Fetch, Storage, Target, Page, Tracing, Log, WebAuthn and WebMCP browser-side handlers ([devtools_session.h](https://chromium.googlesource.com/chromium/src/+/main/content/browser/devtools/devtools_session.h), `IsDomainAvailableToUntrustedClient`). The Chrome layer adds only Page, Emulation, Target and WebMCP ([chrome_devtools_session.cc](https://chromium.googlesource.com/chromium/src/+/main/chrome/browser/devtools/chrome_devtools_session.cc)). Second, several commands need the extension's "Allow access to file URLs" toggle: `DOM.setFileInputFiles`, `Input.dispatchDragEvent` with files, `Page.navigate` to `file://`, and attaching to `file://` pages ([debugger_api.cc](https://chromium.googlesource.com/chromium/src/+/main/chrome/browser/extensions/api/debugger/debugger_api.cc) `MayReadLocalFiles`, [dom_handler.cc](https://chromium.googlesource.com/chromium/src/+/main/content/browser/devtools/protocol/dom_handler.cc)).

## 1. Must update

No CDP command or event that sitegeist sends or listens to was removed or renamed between 141 and tip of tree. The breakage is in extension APIs the code assumes, and in two Chrome behavior changes.

### Verified

#### 1.1 REPL abort does nothing on the userScripts path

`chrome.userScripts.terminate()` and the `executionId` field of `execute()` never shipped. The Chromium `user_scripts.webidl` at `main` has the same eight methods as 141 and neither name. sitegeist probes for `terminate`, passes `executionId` when it finds it, and `supportsTermination()` returns `true` unconditionally, so on the userScripts path a stop request returns `false` while the panel shows termination as supported. The REPL comment "userScripts.terminate (Chrome 138+)" is wrong.

Fix: on the userScripts path, send `Runtime.terminateExecution` through the debugger when the tab is attached (it shares the page's V8 isolate; that it stops a loop in the USER_SCRIPT world is inferred), and make `supportsTermination()` report the real answer.

Code: `sitegeist/src/browser/inject.ts:30`, `:218`, `:226-241`, `sitegeist/src/tools/repl/runtime-providers.ts:178-181`. Effort S. Verified in source.
Source: https://developer.chrome.com/docs/extensions/reference/api/userScripts, https://chromium.googlesource.com/chromium/src/+/main/extensions/common/api/user_scripts.webidl

#### 1.2 A revoked "Allow User Scripts" toggle breaks injection instead of falling back

Since 138, revoking the toggle leaves `chrome.userScripts` defined while its methods throw until the extension context reloads, and turning it on takes effect only after a reload. The docs recommend a `getScripts()` call in try/catch. sitegeist tests `typeof execute === "function"`, so after a revoke it keeps choosing the userScripts path and every injection fails. The bridge's capability report has the same blind spot.

Fix: detect with `getScripts()` in try/catch, and on an `execute()` error retry once through the CDP path.

Code: `sitegeist/src/browser/inject.ts:33-36`, `sitegeist/src/browser/page.ts:142-148`, `sitegeist/src/bridge/native.ts:332`. Effort S. Verified in source.
Source: https://developer.chrome.com/docs/extensions/reference/api/userScripts#check-for-api-availability

#### 1.3 Detaching leaves the page at 1280x800 on Chrome 141 to 153

`detachTab()` drops the debugger without `Emulation.clearDeviceMetricsOverride`. Before 154, Chrome kept the emulated size after detach, so any detach, including the one an extension reload or auto-update causes, left the user's tab rendered at the agent viewport. Chromium fixed this in 154 (commit 51e99ec578, "restore device emulation view size on Emulation disable()"). Browsers on 154 or later are not affected.

Fix: clear the override for tabs in `viewportTabs` before detaching, or raise `minimum_chrome_version` to 154. Raising it also lets later items rely on 142 to 154 APIs without guards.

Code: `sitegeist/src/browser/cdp.ts:149-160`, `sitegeist/static/manifest.chrome.json:3`. Effort S. Verified in source (commit and code read, not probed).
Source: https://chromium.googlesource.com/chromium/src/+/51e99ec578

#### 1.4 Policy checks at debugger attach (Chrome 155 to 157)

From 155, `chrome.debugger.attach()` fails on browsers whose policy sets `runtime_blocked_hosts`, `DisableScreenshots` or DLP screenshot rules, with "Host access is restricted by policy." or "Screenshot capture is restricted by policy.". Google rolled the check back by server config on 2026-11-04, and the `ExtensionDebuggerStrictPolicyRestrictions` feature remains in the code as a kill switch. The generated policy profile sets none of those policies, so the maintainer's browsers are not affected. sitegeist reports either error as "Cannot attach to tab N", which hides the cause.

Fix: map the two messages to an error that names the policy.

Code: `sitegeist/src/browser/cdp.ts:66-70`. Effort S. Verified in source.
Source: https://developer.chrome.com/blog/debugger-enterprise-policy-restrictions, https://chromestatus.com/feature/5072259281715200

#### 1.5 Deprecated names in the bridge's CDP deny list

`Network.getAllCookies` is deprecated in favor of `Storage.getCookies`, and `Page.setDownloadBehavior` in favor of `Browser.setDownloadBehavior`. The replacements are already refused through the `Storage.` and `Browser.` prefixes, so nothing leaks. The list should name what clients will send.

Code: `sitegeist/src/bridge/tools.ts:111-119`. Effort S. Verified in source (protocol JSON).
Source: https://chromedevtools.github.io/devtools-protocol/tot/Network/#method-getAllCookies

#### 1.6 Chrome for Testing has its own native messaging folder (146)

Chrome for Testing reads hosts from `~/Library/Application Support/Google/ChromeForTesting/NativeMessagingHosts`, which `sitegeist install` does not write. The e2e suite writes its own manifest, so only a manual bridge run in Chrome for Testing's default profile is affected.

Code: `sitegeist/cli/src/install.ts:20-36`. Effort S. Verified in source.
Source: https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging

### Inferred

#### 1.7 Split View shows a non-active tab on screen (155)

In a split, two tabs are visible and only one is `active`. sitegeist applies the 1280x800 agent viewport to every tab that is not active and releases it only on `tabs.onActivated`, so an agent tab shown in a split renders letterboxed, and the idle-group logic treats it as unseen. `tabs.createSplit` also requires both tabs in one group, which can conflict with moving tabs into a session group.

Fix: treat a tab whose `splitViewId` matches the active tab's as visible.

Code: `sitegeist/src/browser/cdp.ts:34`, `:114-124`, `sitegeist/src/browser/session.ts:253`. Effort S to M. Inferred.
Source: https://developer.chrome.com/docs/extensions/reference/api/tabs#method-createSplit

#### 1.8 HTTPS warning by default (154)

Chrome now shows a warning page for public `http://` sites the user has not visited recently. An agent `navigate` to such a URL in a hidden tab waits for a load that lands on the interstitial. Private addresses and single-label hosts are excluded; localhost is probably exempt as a secure context.

Fix: detect the interstitial after navigation and report it, or retry over https.

Code: `sitegeist/src/browser/page.ts:88`. Effort S. Inferred (the doc is verified; how the interstitial shows up in `webNavigation` is not).
Source: https://developer.chrome.com/release-notes/154

#### 1.9 Drag and drop now cancels pointer events (148)

Since 148, Chrome sends `pointercancel` to an HTML5-draggable source once a drag starts, and `dropEffect` handling changed in 146 and 148. The mouse-event drag in `drag()` will see that on draggable elements. If drags on such sites regress, `Input.setInterceptDrags` plus `Input.dispatchDragEvent` drives HTML5 drag and drop directly.

Code: `sitegeist/src/browser/cdp.ts:342-366`. Effort S to test, M to switch. Inferred.
Source: https://developer.chrome.com/release-notes/146, https://developer.chrome.com/release-notes/148

#### 1.10 More pages restore from the back/forward cache (149, staged)

Pages with open WebSockets can now enter the bfcache. A restored page keeps old injected globals, and the screencast `initScript` registered with `Page.addScriptToEvaluateOnNewDocument` does not run again. Code that assumes a fresh document after Back may see stale state.

Code: `sitegeist/src/browser/cdp.ts:729-735`, `sitegeist/src/browser/inject.ts:149-173`. Effort S. Inferred.
Source: https://developer.chrome.com/release-notes/149

#### 1.11 Local Network Access prompts for page-world code (142 and later)

Extension pages are exempt: Chromium treats `chrome-extension://` as loopback, so the panel, service worker and offscreen document fetch localhost without a prompt, and top-level navigations to localhost (the OAuth redirects) are not restricted. Code that sitegeist runs in the page's main world through `Runtime.evaluate` is the page's own request, so a REPL snippet that fetches localhost or a LAN address from a public page now triggers that page's permission prompt.

Code: `sitegeist/src/browser/cdp.ts:307`, `sitegeist/src/browser/page.ts:199-210`. Effort S (document it in the REPL prompt). Inferred.
Source: https://developer.chrome.com/release-notes/142, https://developer.chrome.com/release-notes/147

### Checked and unchanged

- CDP in use: `Page.captureScreenshot` (`fromSurface`, `optimizeForSpeed`, `captureBeyondViewport`, `clip.scale`), `Page.getLayoutMetrics` (the code reads the non-deprecated `css*` fields), the screencast trio, `Input.*`, `Emulation.*`, `Runtime.*` and `Network.*` events keep their names and experimental flags. `Runtime.addBinding` by name is fine; only its `executionContextId` parameter is deprecated.
- `chrome.debugger`: no new methods; detach reasons are still `target_closed` and `canceled_by_user`.
- Background tabs: no change to freezing, Energy Saver or intensive throttling rules. Chrome does not discard a tab with a debugger attached.
- Extension platform: `tabGroups` unchanged since `shared` (137), offscreen reasons unchanged, `offscreen.hasDocument()` already present in 141, `captureVisibleTab` still two calls per second, no side panel width API, service worker lifetime unchanged (a native messaging port or an attached debugger keeps the worker alive).
- Third-party cookies: Chrome keeps the current approach (144 notes).

## 2. Improvements

The first three fix behavior that is wrong today on every Chrome version sitegeist supports.

### Verified

#### 2.1 Cmd shortcuts do nothing on macOS

On macOS, a key event with the Meta modifier does not run the editing command behind it; Cocoa key bindings do that outside the renderer. `Input.dispatchKeyEvent` takes a `commands` list (`selectAll`, `copy`, `cut`, `paste`, `undo`, `redo`, `moveToBeginningOfLine` and others) for this. sitegeist sends none, so the bridge's `press` with "Meta+a" and Meta chords built with the REPL's `nativeKeyDown` do nothing in a text field. Separately, the REPL's `nativePress` sends no `modifiers`, so it drops keys held with `nativeKeyDown`.

Fix: on macOS, map Meta chords to their editing commands in `pressKey()` and in the REPL provider, and pass the held modifiers in `nativePress`.

Code: `sitegeist/src/browser/cdp.ts:471-512`, `sitegeist/src/bridge/tools.ts:558-565`, `sitegeist/src/tools/NativeInputEventsRuntimeProvider.ts:298-343`. Effort S. Verified by probe: in a focused textarea with 11 characters, `rawKeyDown` "a" with `modifiers: 4` selected 0 characters; adding `commands: ["selectAll"]` selected 11.
Source: https://chromedevtools.github.io/devtools-protocol/tot/Input/#method-dispatchKeyEvent, https://source.chromium.org/chromium/chromium/src/+/main:third_party/blink/renderer/core/editing/commands/editor_command_names.h

#### 2.2 The screencast frame cap is three times looser than the code assumes

Chrome keeps up to three screencast frames in flight before it waits for an ack. sitegeist caps the frame rate by holding the ack (comment: "Chrome sends the next frame only after this ack"), so an animating page delivers about three times `maxFps`. The GIF recorder asks for 4 fps and keeps every frame, so it reaches its 200-frame cap three times sooner and starts dropping every other frame. Bridge clients streaming frames get three times the traffic they asked for.

Chrome 154 added `maxFramesInFlight` (default 3) and `sendLastFrame` to `Page.startScreencast`. `maxFramesInFlight: 1` makes the ack hold an exact cap. `sendLastFrame: true` sends the newest frame as soon as the held ack goes out, which covers the "end state may not have a frame yet" case the recorder patches with a still. Chrome before 154 ignores unknown fields (`protocol_core.cc`: "Unknown field is not an error"), so no version check is needed.

Code: `sitegeist/src/browser/cdp.ts:689`, `:737-743`, `sitegeist/src/recording/gif-recorder.ts:20`, `:64-68`, `:104`. Effort S. Verified by probe: animated page, ack held 250 ms (a 4 fps cap): 24 frames in 2 s by default, 8 with `maxFramesInFlight: 1`, and 3 frames with no ack at all. Chrome 141's source has the same three-frame limit (`kMaxScreencastFramesInFlight = 2` checked with `<=`).
Source: https://chromedevtools.github.io/devtools-protocol/tot/Page/#method-startScreencast, https://chromium.googlesource.com/chromium/src/+/88c9e8a46a

#### 2.3 A page dialog wedges the tab

sitegeist has no handler for JavaScript dialogs, and it enables the Page domain only while a screencast runs. When a page in an agent tab opens `alert`, `confirm`, `prompt` or a `beforeunload` dialog, every later `Runtime.evaluate` on that tab gets no reply, so snapshot, find, click-by-ref and REPL calls hang.

Fix: enable Page at attach, listen for `Page.javascriptDialogOpening`, accept `alert` and `beforeunload`, and answer `confirm` and `prompt` with `Page.handleJavaScriptDialog`, reporting the message to the agent (and as a bridge event) so it can choose.

Code: `sitegeist/src/browser/cdp.ts:57-78`, `:728`. Effort M. Verified by probe: with an `alert()` open, `Runtime.evaluate("2+2")` got no reply within 3 s and `Page.javascriptDialogOpening` fired. With the Page domain disabled the dialog goes to the tab's own UI; that script stays blocked there too is inferred.
Source: https://chromedevtools.github.io/devtools-protocol/tot/Page/#method-handleJavaScriptDialog

#### 2.4 File upload through CDP instead of a page script

`upload_file` builds a `DataTransfer` in the page from base64 and assigns `input.files`, which caps files at 25 MB (36 MB of base64), fires untrusted `input`/`change` events, cannot reach inputs inside closed shadow roots or cross-origin frames, and forbids clicking upload buttons because of the native picker. CDP offers three better paths, all open to extensions once "Allow access to file URLs" is on:

- `DOM.setFileInputFiles` with a `backendNodeId` and a path the native host wrote.
- `Page.setInterceptFileChooserDialog` plus `Page.fileChooserOpened`: the agent clicks the real upload button, Chrome suppresses the picker and reports the input, and the extension fills it.
- `Input.dispatchDragEvent` with `data.files` for drop zones, with trusted drag events.

Keep the current path as the fallback when the toggle is off.

Code: `sitegeist/src/browser/page.ts:475-510`, `sitegeist/src/tools/upload-file.ts:23`, `:40`, `:85`, `sitegeist/src/bridge/tools.ts:376` (`upload.commit`). Effort M (the native host has to write the file). Verified in source (`DOMHandler::SetFileInputFiles` and `InputHandler::DispatchDragEvent` refuse without file access; DOM, Input and Page are on the untrusted allowlist).
Source: https://chromedevtools.github.io/devtools-protocol/tot/DOM/#method-setFileInputFiles, https://chromedevtools.github.io/devtools-protocol/tot/Page/#method-setInterceptFileChooserDialog

#### 2.5 Side panel close and open/close events (141, 142)

`sidePanel.close({tabId})` exists from 141 (marked `[nodoc]` in 141's `side_panel.idl`, documented now), `onOpened` from 141 and `onClosed` from 142. The Cmd+Shift+S command only opens the panel, and the comment "Chrome offers no per-tab close API" is out of date. The events report window, tab and path, and could replace the port bookkeeping that knows only the window. Since 145, `close({tabId})` rejects when only the global panel is open.

Code: `sitegeist/src/background.ts:236-255`, `:284-289`. Effort S. Verified in source.
Source: https://developer.chrome.com/docs/extensions/reference/api/sidePanel#method-close

#### 2.6 Video recording from Chrome (153)

`Page.startScreenRecording` and `Page.stopScreenRecording` encode the tab as video in the browser and return an IO stream. Recording the tab is open to extensions; only `captureArea: "browserWindow"` needs a trusted client. IO is on the untrusted allowlist, so `IO.read` works. This could add a video export next to the GIF and move encoding out of the offscreen worker. It needs libaom; a build without it answers "Video recording is not supported without AV1/libaom enabled."

Code: `sitegeist/src/recording/gif-recorder.ts:77-92`, `sitegeist/src/bridge/tools.ts:402-445`. Effort M. Verified by probe: Chrome for Testing 157 returned a stream starting with an MP4 `ftyp` box (AV1 per the source). Whether it records a hidden tab is inferred: the recorder answers after 5 s without a first frame "for a window that sends no frames while it is hidden".
Source: https://chromedevtools.github.io/devtools-protocol/tot/Page/#method-startScreenRecording, https://chromium.googlesource.com/chromium/src/+/main/content/browser/devtools/protocol/page_handler.cc

#### 2.7 Run the debugger fallback in an isolated world

Without the userScripts toggle, sitegeist evaluates snapshot, find and REPL code in the page's main world and installs `window.__sitegeistChrome`, `__sitegeistPending` and the `__sitegeistSend` binding there. Page scripts can see and call all of them, and pages that patch built-ins can break the snapshot code. While a REPL call runs, its runtime helpers (`nativeClick`, `sendRuntimeMessage` and others) are also page globals. `Page.createIsolatedWorld` gives an execution context the page cannot touch; `Runtime.evaluate` takes its `contextId`, and `Runtime.addBinding` with `executionContextName` exposes the binding only there. That gives the debugger path the same isolation as the userScripts path.

Code: `sitegeist/src/browser/inject.ts:136-184`, `sitegeist/src/browser/page.ts:199-210`, `sitegeist/src/browser/cdp.ts:307-318`. Effort M. Verified in source (code read). That a page can drive the agent through these globals is inferred, not probed.
Source: https://chromedevtools.github.io/devtools-protocol/tot/Page/#method-createIsolatedWorld, https://chromedevtools.github.io/devtools-protocol/tot/Runtime/#method-addBinding

#### 2.8 Console reading through the Log domain

Console capture listens to `Runtime.consoleAPICalled` and `Runtime.exceptionThrown` and starts empty when the agent first asks. `Log.enable` replays the entries collected so far and adds browser-side messages: failed resource loads, CSP violations, interventions and deprecations, which are often the error the agent is looking for. Log is on the untrusted allowlist.

Code: `sitegeist/src/browser/cdp.ts:539-596`. Effort S. Verified in source.
Source: https://chromedevtools.github.io/devtools-protocol/tot/Log/#method-enable

#### 2.9 Network response bodies

Network capture keeps method, URL, status and MIME type only. `Network.getResponseBody` returns the body for a captured request, and `Network.configureDurableMessages` (145) keeps bodies across cross-process navigations. A `body: true` option on the network tool would let an agent read an API response instead of scraping the rendered page.

Code: `sitegeist/src/browser/cdp.ts:562-582`, `:619-645`. Effort S to M. Verified in source.
Source: https://chromedevtools.github.io/devtools-protocol/tot/Network/#method-getResponseBody

#### 2.10 Cross-origin iframes through child sessions

Every command goes to `{tabId}`, and snapshot and injection run in the main frame only (`allFrames: false`), so content in cross-origin iframes (embedded checkouts, editors, consent dialogs) is invisible to the agent. `Target.setAutoAttach` with `flatten: true` and `chrome.debugger.sendCommand({tabId, sessionId}, ...)` (child sessions since 125) reach those frames; Chrome filters each child target through the same URL checks as a tab. Since 143 extensions may also call `Target.closeTarget` (commit 53e7f0ae3c).

Code: `sitegeist/src/browser/cdp.ts:52-54`, `sitegeist/src/browser/page.ts:181`. Effort M to L. Verified in source (`SendMessageToBackend` and the `Target.attachedToTarget` filtering in `debugger_api.cc`).
Source: https://developer.chrome.com/docs/extensions/reference/api/debugger#type-DebuggerSession, https://chromium.googlesource.com/chromium/src/+/53e7f0ae3c

#### 2.11 Better viewport emulation (147, 155, 156)

`Emulation.setDeviceMetricsOverride` gained `scrollbarType` (147), `viewportMeta` (155) and `textLayoutMode` (156). `scrollbarType: "overlay"` keeps the 1280x800 agent viewport free of a scrollbar gutter, so screenshot and page coordinates match exactly. The other two separate meta-viewport handling and text autosizing from `mobile: true` for `resize_window`. Older Chrome ignores the fields.

Code: `sitegeist/src/browser/cdp.ts:102-112`, `sitegeist/src/bridge/tools.ts:483-511`. Effort S. Verified in source (protocol JSON).
Source: https://chromedevtools.github.io/devtools-protocol/tot/Emulation/#method-setDeviceMetricsOverride

#### 2.12 Click markers drawn by Chrome (157)

`Page.setInputVisualization({clicks: true})` makes Chrome draw click feedback in the page, so it shows in screencast frames and for a user watching the tab. The GIF recorder draws its own markers at encode time; this would give the live view the same cue. It landed at r1717327, just before the 157 branch point (r1717349).

Code: `sitegeist/src/browser/cdp.ts:322-336`, `sitegeist/src/recording/gif-recorder.ts`. Effort S. Verified in source; its value for the GIF is inferred.
Source: https://chromium.googlesource.com/chromium/src/+/0b268b1263

#### 2.13 Small extension API additions

- `contextMenus` "tab" context (150): "Add to sitegeist task" on a tab's right-click menu, receiving all selected tabs. Needs a version guard below 150. Code `sitegeist/src/background.ts:263-266`.
- `runtime.onExtensionLoaded` (157): one event for install, update, enable, reload and startup, a single place to re-arm the bridge and self-update. Code `sitegeist/src/bridge/native.ts:516`, `sitegeist/src/utils/self-update.ts`.
- Structured-clone messaging (148, manifest key `"message_serialization": "structured_clone"`): frames and blobs between panel, worker and offscreen document without base64. Native messaging stays JSON. Code `sitegeist/src/recording/gif-recorder.ts:145-155`.
- `userScripts.execute()` checks syntax up front (149) and returns diagnostics, so REPL syntax errors can come back as a clear message. Code `sitegeist/src/browser/inject.ts:212-222`.

Effort S each. Verified in source (Chromium `runtime.json`, `context_menus.json`) and docs.
Source: https://developer.chrome.com/docs/extensions/whats-new, https://developer.chrome.com/docs/extensions/reference/api/runtime#event-onExtensionLoaded

### Inferred

#### 2.14 Page tools through WebMCP (149)

The WebMCP domain (`enable`, `toolsAdded`, `invokeTool`, `toolResponded`) lets the extension list the tools a page registers through the WebMCP API and call them, instead of clicking through the UI. It has been open to `chrome.debugger` since 149 (commit 71a14cdc4f), and `WebMCP.enable` answered on the 157 probe. The page-side API ran as an origin trial from 149 to 156 and has not shipped, so how many sites expose tools on 157 is unknown. The protocol marks tool output as untrusted.

Code: new tool next to `sitegeist/src/bridge/tools.ts:637` (`cdp`). Effort M. Inferred value; access verified in source and by probe.
Source: https://chromestatus.com/feature/5117755740913664, https://chromedevtools.github.io/devtools-protocol/tot/WebMCP/

#### 2.15 Chrome's annotated page content for snapshots (144)

`Page.getAnnotatedPageContent` returns the page model Chrome's own AI features use, with actionable elements, as a base64 protobuf (`AnnotatedPageContent` in `common_quality_data.proto`). It could replace or check the DOM walk behind `snapshot`. It answered on the 157 probe (868 base64 characters for a small page) and sits in a Page handler extensions can reach. Decoding needs the proto definition, the format is marked "subject to change", and Helium may lack the components behind it. `Accessibility.getFullAXTree` is the stable alternative.

Code: `sitegeist/src/browser/page.ts:244`, `:359-368`. Effort L. Inferred value.
Source: https://chromedevtools.github.io/devtools-protocol/tot/Page/#method-getAnnotatedPageContent

#### 2.16 Put the agent tab beside the user's (155)

The Split View API (`tabs.create({splitWithTabId})`, `tabs.createSplit`, `tabs.unsplit`, no permission) could show an agent tab next to the user's tab when they want to watch, instead of switching tabs. Agent tabs are created hidden today. Depends on 1.7.

Code: `sitegeist/src/browser/session.ts:669`. Effort M. Inferred value.
Source: https://developer.chrome.com/blog/split-view-api-extensions

### Not available to extensions

- `FindInPage` (157): not on the untrusted allowlist. Verified in source.
- `Extensions.*` (`triggerAction`, `getExtensions`): needs `--remote-debugging-pipe` and `--enable-unsafe-extension-debugging`, so only the e2e harness could use it. Verified in docs.
- `Page.startScreenRecording` with `captureArea: "browserWindow"` and `Page.captureScreenshot` with `fromSurface: false`: trusted clients only. Verified in source.

## 3. Features and permissions for the maintainer's browsers

Google Chrome on macOS reads every policy from the user-approved profile (`/Library/Managed Preferences/<user>/com.google.Chrome.plist`). It filters out only two things on a Mac that is not MDM-enrolled, MCX-joined or enrolled in Chrome Enterprise Core: about 20 policies marked sensitive (none of those below), and `ExtensionInstallForcelist` or `ExtensionSettings` entries that force or normally install from a non-Web-Store `update_url`, which Chrome tags `[BLOCKED]` ([policy_loader_common.cc](https://chromium.googlesource.com/chromium/src/+/main/components/policy/core/common/policy_loader_common.cc)). The profile from `scripts/pack-crx.mjs` sets `ExtensionInstallAllowlist` and `ExtensionInstallSources` today, in a `com.google.Chrome` payload only (`sitegeist/scripts/pack-crx.mjs:118-148`).

No improvement in section 2 needs a new manifest permission.

### Verified

#### 3.1 Turn on "Allow access to file URLs" for sitegeist

A per-browser toggle under chrome://extensions, sitegeist, Details. It enables the CDP upload paths in 2.4, attaching to and navigating `file://` pages, and reading local HTML reports the agent produces. No policy or flag sets it, and it is not a manifest permission, so it causes no install warning. `isRestrictedUrl` does not block `file://`, so no code change is needed to use it.

Works from: a manual toggle in Chrome and in Helium; no MDM. Code: `sitegeist/src/browser/cdp.ts:15-29`. Effort: one click per browser. Verified in source (`MayReadLocalFiles`, `kFileUrlsRequireFileAccess` in `debugger_api.cc`).

#### 3.2 A per-id ExtensionSettings entry in the profile

```json
{ "lnncppjiohlpejgcbdgoihplimdckddn": {
    "installation_mode": "allowed",
    "toolbar_pin": "force_pinned",
    "file_url_navigation_allowed": true } }
```

`toolbar_pin` keeps the action on the toolbar whatever the install mode. `file_url_navigation_allowed` lets `chrome.tabs.create` and `update` open `file://` URLs. With `allowed` and no `update_url`, the loader does not filter the entry. Avoid a `"*"` entry with `runtime_blocked_hosts` unless sitegeist has its own entry (see 3.9).

Works from: the user-approved profile. Code: `sitegeist/scripts/pack-crx.mjs:143-147`. Effort S. Verified in source (`toolbar_actions_model.cc`, `extension_tab_util.cc`).
Source: https://chromeenterprise.google/policies/#ExtensionSettings

#### 3.3 Fix `ExtensionInstallSources` for typed or opened URLs

Chrome also requires the referring page to match an `ExtensionInstallSources` pattern, except for `file://` URLs. Opening the https `.crx` URL directly therefore fails, while a `file://` CRX URL works. Adding `file:///<release dir>/*` makes that path explicit; installing from a link on a page under the codebase also works.

Works from: the user-approved profile. Code: `sitegeist/scripts/pack-crx.mjs:118-125`. Effort S. Verified in source (`extension_management.cc`).
Source: https://chromeenterprise.google/policies/#ExtensionInstallSources

#### 3.4 Helium needs no profile, and reads its own policy domain

Helium is an unbranded build, so it skips the off-store check that Google Chrome runs on macOS (`install_verifier.cc`), re-enables extension update checks so the self-hosted channel works, and replaces the debugger infobar with a small chip in the address bar. It reads policy from `net.imput.helium`, not `com.google.Chrome`. Add a `net.imput.helium` payload only to get 3.2 in Helium.

Works from: no profile needed; a second payload for 3.2. Code: `sitegeist/scripts/pack-crx.mjs:138`. Effort S. Verified in source (Helium patches `change-chromium-branding.patch`, `reenable-update-checks.patch`, `compact-debugger-warning.patch`, Chromium `chrome_browser_policy_connector.cc`).
Source: https://github.com/imputnet/helium

#### 3.5 Removing the debugger infobar in Google Chrome

Chrome skips the "started debugging this browser" infobar for policy-installed extensions and with `--silent-debugger-extension-api` (`ExtensionDevToolsClientHost::Attach` in `debugger_api.cc`). That also removes the Cancel button that makes sitegeist ban a tab (`canceled_by_user`, `sitegeist/src/browser/cdp.ts:39`).

- Policy install (`installation_mode: "force_installed"` with the self-hosted `update_url`): filtered as `[BLOCKED]` from a user-approved profile. Needs MDM, MCX or Chrome Enterprise Core. With a force install, also set `DeveloperToolsAvailability` to 1, since its default blocks DevTools on policy-installed extensions' own pages.
- The switch works in branded Chrome and is not on the bad-flags list, but macOS has no persistent flags file: it holds only for a launch with `open -a "Google Chrome" --args --silent-debugger-extension-api`, and a Dock or login launch drops it.

Works from: MDM or Chrome Enterprise Core for the policy; command line only for the switch. Effort L (policy) or S but fragile (switch). Verified in source.
Source: https://chromium.googlesource.com/chromium/src/+/main/chrome/browser/extensions/api/debugger/debugger_api.cc

#### 3.6 Debugger on chrome:// pages: Helium only, not recommended

`extensions-on-chrome-urls` lets extensions and the debugger reach `chrome://` pages. Google Chrome builds ignore the switch (`kDisableExtensionsOnChromeUrlsSwitch` is on in branded builds); in Helium it is a chrome://flags entry that persists. sitegeist would also have to stop rejecting `chrome://` in `isRestrictedUrl`. The flag is on Chrome's bad-flags list, and it lets an agent change chrome://settings and chrome://extensions. `devtools://` and the Chrome Web Store stay unreachable whatever the flags.

Works from: a Helium flag. Code: `sitegeist/src/browser/cdp.ts:15-29`. Effort S. Verified in source (`extension_features.cc`, `permissions_data.cc`, `chrome_extensions_client.cc`).

#### 3.7 No policy or switch for the userScripts toggle

"Allow User Scripts" is a per-extension preference; `ExtensionDeveloperModeSettings` does not control it. Keep the CDP fallback and fix it per 1.2 and 2.7.

Code: `sitegeist/src/browser/inject.ts:1-16`. Verified in source (`user_script_manager.cc`).

### Inferred

#### 3.8 `BackgroundTabFreezingEnabled` false (155)

A new policy; when unset, background tab freezing is on. Chrome's freezing exemptions include "visible", capture and WebRTC, but nothing for DevTools or the debugger. sitegeist's focus emulation probably keeps agent tabs counted as visible (it raises the capturer count), in which case nothing gets frozen. Check chrome://discards on an agent tab that sat in a collapsed group for five minutes before setting it. If tabs do freeze, the policy fixes it from the profile, and `Page.setWebLifecycleState("active")` is the code-side fix.

Works from: the user-approved profile. Code: `sitegeist/src/browser/cdp.ts:75`, `sitegeist/src/browser/session.ts:255`. Effort S. Inferred (the policy and its default are verified).
Source: https://chromeenterprise.google/policies/#BackgroundTabFreezingEnabled

#### 3.9 Optional `downloads` permission

`chrome.downloads` would let the agent find a file a page just downloaded and bring it into the chat. It triggers an install warning, so it has to be optional and requested at first use, like `notifications`.

Works from: the manifest's `optional_permissions`. Code: `sitegeist/static/manifest.chrome.json:44-47`. Effort M. Inferred value.
Source: https://developer.chrome.com/docs/extensions/reference/api/downloads

### Leave these unset

- `runtime_blocked_hosts` on sitegeist's id: from 155 it can disable `chrome.debugger.attach()` (1.4).
- `DeveloperToolsAvailability` 2, or a `DeveloperToolsAvailabilityAllowlist` without a matching blocklist: both block `chrome.debugger`.
- `NativeMessagingUserLevelHosts` false, or `NativeMessagingBlocklist` `["*"]` without the sitegeist host in `NativeMessagingAllowlist`: the host manifest is installed per user (`sitegeist/cli/src/install.ts:143-147`).
- `blocked_permissions` with `debugger`, `nativeMessaging` or `userScripts`, and `minimum_version_required` (disables sitegeist whenever an update lags).
- No gain: memory saver and discard exceptions (a debugger-attached tab is not discarded), `IntensiveWakeUpThrottlingEnabled` (focus emulation covers it), `ExtensionExtendedBackgroundLifetimeForPortConnectionsToURLs` (the native port keeps the worker alive), Local Network Access policies (website requests only), `RemoteDebuggingAllowed`.

Verified in source and policy docs: https://chromeenterprise.google/policies/
