// The panel in a real side panel, not a tab: opened through chrome.sidePanel on a tab, it binds
// to that tab, drives the page and clears its busy state when the run ends.
// Run: SITEGEIST_VERSION=9.9.9 node scripts/build.mjs && npm run test:e2e

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { Browser, composerReady, EXTENSION_ID, seedProvider, sendPrompt, startFakeServer } from "./lib.mjs";

let browser;
let server;

before(async () => {
	server = await startFakeServer({
		routes: { "/page": "<!doctype html><title>Real panel</title><h1>Real panel page</h1>" },
		script: (_body, index) =>
			index === 0
				? {
						toolCalls: [
							{
								name: "repl",
								args: {
									title: "Read",
									code: `return await browserjs(() => document.querySelector("h1").textContent);`,
								},
							},
						],
					}
				: { text: "side panel works" },
	});
	browser = await Browser.launch();
});

after(async () => {
	await browser.close();
	await server.close();
});

test("a run in a real side panel", async () => {
	const worker = await browser.worker();
	const tab = await browser.open(`${server.origin}/page`);
	await tab.waitFor(`document.title === "Real panel"`);
	const tabId = await worker.evaluate(
		`chrome.tabs.query({}).then((ts) => ts.find((t) => (t.url || "").endsWith("/page")).id)`,
	);

	// sidePanel.open needs a user gesture, which an evaluate in an extension page can carry.
	const helper = await browser.open(`chrome-extension://${EXTENSION_ID}/sidepanel.html`);
	await composerReady(helper);
	await seedProvider(helper, server.baseUrl);
	await tab.send("Page.bringToFront");
	await helper.evaluate(`(async () => {
		await chrome.sidePanel.setOptions({ tabId: ${tabId}, path: "sidepanel.html?tabId=${tabId}", enabled: true });
		await chrome.sidePanel.open({ tabId: ${tabId} });
	})()`);

	const deadline = Date.now() + 10000;
	let target;
	while (!target && Date.now() < deadline) {
		target = (await browser.targets()).find((t) => t.url.includes(`sidepanel.html?tabId=${tabId}`));
		await new Promise((r) => setTimeout(r, 100));
	}
	assert.ok(target, "the side panel must open");
	const panel = await browser.attach(target.targetId);
	await panel.send("Runtime.enable");
	await panel.send("Page.enable");
	await composerReady(panel);
	await helper.close();

	await sendPrompt(panel, "read the heading");
	await panel.waitFor(`document.body.innerText.includes("side panel works")`, { timeoutMs: 15000 });
	const tool = server.requests[1].messages.filter((m) => m.role === "tool").at(-1);
	assert.ok(JSON.stringify(tool.content).includes("Real panel page"));

	const sessions = await worker.evaluate(
		`chrome.storage.local.get("browser_sessions").then((d) => Object.values(d.browser_sessions))`,
	);
	assert.ok(
		sessions.some((s) => s.homeTabId === tabId && s.tabIds.includes(tabId)),
		"the session must own its tab",
	);
	const busy = await worker.evaluate(
		`chrome.storage.session.get(null).then((d) => Object.keys(d).filter((k) => k.startsWith("sidepanel_busy")).map((k) => d[k]))`,
	);
	assert.ok(
		busy.every((value) => value === false),
		"the run must clear its busy state",
	);
});
