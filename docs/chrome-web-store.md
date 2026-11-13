# Chrome Web Store

The fork ships as an Unlisted item: installable from its store link, not shown in search. Chrome and Helium then update it themselves. Every version is reviewed before it goes live.

## Building the upload

```sh
scripts/store-zip.sh                 # release/store/sitegeist-<version>.zip
scripts/store-zip.sh --first-upload  # the same zip plus key.pem, in a temp folder
```

The version is `<major>.<minor>.<commits on HEAD>`, as `release-crx.sh` makes it. The zip has no `key` and no `update_url` (the store rejects the first and serves updates itself) and no source maps.

The first upload of the item uses `--first-upload`. It adds "sitegeist CRX signing key" from 1Password DEV as `key.pem`, which gives the store item the id the self-hosted releases have, `lnncppjiohlpejgcbdgoihplimdckddn`. The native host manifests (`cli/src/install.ts`) and the data in existing installs stay valid. Delete the temp folder after the upload. Later uploads use the plain zip.

## Policy review (Manifest V3 remote code, read 2026-11-13)

[Program policy](https://developer.chrome.com/docs/webstore/program-policies/mv3-requirements): the extension's logic has to be in the package. Two exemptions cover the code sitegeist runs that is not:

- Sandboxed pages, which have no extension API access, may load remote code. `sandbox.html` is one (manifest `sandbox.pages`). Its CSP allows `unsafe-eval` and CDN scripts for the HTML and JavaScript the model writes. The extension pages' CSP stays `script-src 'self'`.
- Remote logic may run through a documented API that allows it: the Debugger API and the User Scripts API. Page scripts go through `chrome.userScripts.execute` (`src/browser/inject.ts`) or, with that toggle off, `Runtime.evaluate` over `chrome.debugger` (`src/browser/cdp.ts`).

So the build stays as it is. The dashboard's remote-code answer is "Yes", with the justification below.

## Listing

Name (from the manifest): Sitegeist Bridge (unofficial fork)

Summary (manifest `description`): An AI side panel, and a bridge that lets coding agents use your browser. Unofficial sitegeist fork, not by sitegeist.ai.

Category: Developer Tools. Language: English.

Description:

```
Sitegeist Bridge is an AI assistant in Chrome's side panel, and a bridge that lets coding agents on your computer use your browser.

It is an unofficial fork of sitegeist (https://github.com/badlogic/sitegeist), not made by or affiliated with sitegeist.ai.

Ask in the side panel and it works on the page you are on: it reads pages, fills forms, clicks through multi-step flows, collects data across tabs, and turns what it finds into documents and spreadsheets. Each chat gets its own tab group. Its tabs open in the background, and it does not touch your other tabs.

Through the bridge, Claude Code, Codex or any MCP client drives the same browser with the sitegeist command-line tool, on the sites you are already signed in to.

You choose the model: an Anthropic, OpenAI, GitHub Copilot or Google Gemini subscription, an API key, or a local model through Ollama. Requests go from your browser straight to that provider. There is no sitegeist server, no account and no tracking.

Source code (AGPL-3.0): https://github.com/Shahfarzane/sitegeist
```

Store icon: `static/icon-128.png`. Screenshot (1280x800) and small promo tile (440x280): `docs/chrome-web-store/`.

Privacy policy: https://github.com/Shahfarzane/sitegeist/blob/main/PRIVACY.md

## Privacy practices tab

Single purpose:

```
An AI assistant that reads and operates web pages for the user, from the side panel chat or for coding agents on the same computer through the bridge.
```

Permission justifications:

| Permission | Justification |
|---|---|
| storage | Keeps settings, provider keys, chats, skills and saved prompts in the browser profile. |
| unlimitedStorage | Chats with screenshots and attached files outgrow the default storage quota. |
| activeTab | Lets the assistant act on the tab the user opened the side panel on. |
| scripting | Runs the assistant's page reading and form filling scripts in tabs the user gives it. |
| sidePanel | The assistant's chat is in the side panel. |
| webNavigation | Tells the assistant when a page it opened has loaded, and tracks navigations while it records a tab. |
| debugger | Operates pages through the Chrome DevTools Protocol: real clicks and key presses, screenshots of background tabs, file uploads, and console and network reading for debugging. Only on tabs in the assistant's own tab group. |
| declarativeNetRequest | Adds CORS headers to responses from a few AI provider sign-in and API endpoints that block browser requests (rules in cors-rules.json). |
| tabGroups | Each chat keeps its tabs in a group of its own, so it does not act on the user's other tabs. |
| nativeMessaging | Connects to the sitegeist command-line tool on the same computer, which coding agents use to reach the browser, and to local MCP connectors. |
| alarms | Pings every 30 seconds to keep the bridge connection to the command-line tool alive. |
| offscreen | Plays the notification sound and encodes screen recordings (GIF and MP4) off the main thread. |
| contextMenus | Adds "Ask Sitegeist about this page", "about the selection" and "about these tabs" to the right-click menu. |
| Host permissions (http, https) | The assistant works on any site the user sends it to, and calls the AI provider the user chose. |
| userScripts (optional) | Runs the assistant's page scripts in an isolated world when the user turns it on. |
| notifications (optional) | Shows a desktop notification when a task finishes, fails or needs the user. |
| downloads (optional) | Lets the assistant see files a page downloaded, when the user turns it on. |

Remote code: Yes.

```
Two parts run code that is not in the package, both under the policy's exemptions. 1) sandbox.html is a sandboxed page with no access to extension APIs. It renders HTML and JavaScript the AI model writes (charts, small apps, data views) and may load open-source libraries from jsDelivr, unpkg, cdnjs, esm.sh and similar CDNs. 2) Scripts the assistant runs in web pages go through chrome.userScripts.execute, or chrome.debugger's Runtime.evaluate when userScripts is off, only on tabs in the assistant's tab group. The extension's own logic is all in the package.
```

Data usage, collected: Website content (page text and screenshots the assistant sends to the AI provider the user chose), Authentication information (the user's provider API keys and sign-in tokens, sent only to that provider). Nothing else.

Certifications, all three ticked: not sold to third parties; not used or transferred for purposes unrelated to the single purpose; not used to determine creditworthiness or for lending.
