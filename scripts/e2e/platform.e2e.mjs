// Chrome 154 to 157 platform behavior on the real path: the user scripts toggle revoked
// mid-session, and an agent tab shown in a split view.
// Run: SITEGEIST_VERSION=9.9.9 node scripts/build.mjs && (cd cli && npm run build) && npm run test:e2e

import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { Browser, bridgeReady, EXTENSION_ID, Harness, repoRoot, startFakeServer } from "./lib.mjs";

let browser;
let worker;
let server;
let harness;
let copy;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Flip "Allow User Scripts" the way the extensions page does. */
async function setUserScripts(on) {
	const page = await browser.open(`chrome://extensions/?id=${EXTENSION_ID}`);
	await sleep(500);
	const result = await page.evaluate(
		`new Promise((res) => chrome.developerPrivate.updateExtensionConfiguration({ extensionId: "${EXTENSION_ID}", userScriptsAccess: ${on} }, () => res(chrome.runtime.lastError?.message ?? "ok")))`,
	);
	assert.equal(result, "ok");
	await page.close();
	await sleep(300);
}

before(async () => {
	server = await startFakeServer({
		routes: { "/p": "<!doctype html><title>P</title><p>page</p>" },
		script: () => ({ text: "unused" }),
	});
	// The REPL's userScripts permission is optional; this copy asks for it up front.
	copy = mkdtempSync(join(tmpdir(), "sitegeist-e2e-ext-"));
	cpSync(process.env.SITEGEIST_E2E_EXTENSION ?? join(repoRoot, "dist-chrome"), copy, { recursive: true });
	const manifestPath = join(copy, "manifest.json");
	const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
	manifest.permissions.push("userScripts");
	writeFileSync(manifestPath, JSON.stringify(manifest));
	browser = await Browser.launch({ extensionDir: copy, bridge: true });
	worker = await browser.worker();
	await bridgeReady(browser);
	harness = await Harness.connect(browser);
});

after(async () => {
	await harness?.close();
	await browser?.close();
	await server?.close();
	if (copy) rmSync(copy, { recursive: true, force: true });
});

// The debugger path installs its messaging shim in the page's main world; the user script world has none.
const world = async () =>
	(await harness.callText("run_js", { code: "typeof window.__sitegeistPending === 'undefined' ? 'user' : 'main'" }))
		.value;

test("scripts keep running after Allow User Scripts is turned off mid-session", async () => {
	await harness.callText("navigate", { url: `${server.origin}/p` });
	await setUserScripts(true);
	assert.equal(await world(), "user");
	await setUserScripts(false);
	// execute() still exists but throws; the call must fall back to the debugger path.
	assert.equal(await world(), "main");
	assert.equal((await harness.callText("run_js", { code: "document.title" })).value, "P");
});

test("an agent tab shown in a split view gets its real size back", async () => {
	await harness.callText("navigate", { url: `${server.origin}/p` });
	const width = async () => (await harness.callText("run_js", { code: "innerWidth", world: "main" })).value;
	assert.equal(await width(), 1280, "a hidden agent tab renders at the agent viewport");
	const split = await worker.evaluate(`(async () => {
		const [agent] = (await chrome.tabs.query({})).filter((t) => t.url?.startsWith(${JSON.stringify(server.origin)}));
		const mine = await chrome.tabs.create({ windowId: agent.windowId, index: agent.index + 1, url: "about:blank", active: true });
		if (agent.groupId !== -1) await chrome.tabs.group({ groupId: agent.groupId, tabIds: [mine.id] });
		return chrome.tabs.createSplit([agent.id, mine.id]).then((id) => String(id), (e) => "ERR " + e.message);
	})()`);
	assert.ok(!String(split).startsWith("ERR"), split);
	await sleep(500);
	assert.notEqual(await width(), 1280, "the user can see the tab, so it must not be letterboxed");
});
