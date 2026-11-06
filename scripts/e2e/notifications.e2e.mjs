// Notifications. The optional permission cannot be granted without a click on Chrome's prompt, so
// the granted case runs on a copy of the build that asks for it up front.
// Run: SITEGEIST_VERSION=9.9.9 node scripts/build.mjs && (cd cli && npm run build) && npm run test:e2e

import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { Browser, bridgeReady, Harness, openPanel, pageText, repoRoot, sendPrompt, startFakeServer } from "./lib.mjs";

const page = "<!doctype html><title>Notify</title><h1>Notify</h1>";
const LONG_RUN = { tokens: Array.from({ length: 160 }, (_, i) => `w${i} `), delayMs: 100 };

let granted;
let server;
let copy;

before(async () => {
	server = await startFakeServer({
		routes: { "/n1": page, "/n2": page, "/n3": page },
		script: () => LONG_RUN,
	});
	copy = mkdtempSync(join(tmpdir(), "sitegeist-e2e-ext-"));
	cpSync(join(repoRoot, "dist-chrome"), copy, { recursive: true });
	const manifestPath = join(copy, "manifest.json");
	const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
	manifest.permissions.push("notifications");
	writeFileSync(manifestPath, JSON.stringify(manifest));
	granted = await Browser.launch({ extensionDir: copy, bridge: true });
	await granted.worker();
	await bridgeReady(granted);
});

after(async () => {
	await granted.close();
	await server.close();
	rmSync(copy, { recursive: true, force: true });
});

const shown = (worker) => worker.evaluate(`chrome.notifications.getAll().then((all) => Object.keys(all))`);

test("a harness can call the user", async () => {
	const harness = await Harness.connect(granted);
	const result = await harness.callText("notify_user", {
		title: "Log in please",
		message: "The site asks for a login",
	});
	assert.deepEqual(result, { shown: true });
	const worker = await granted.worker();
	assert.equal((await shown(worker)).length, 1);
	await harness.close();
});

test("a long run that finishes unwatched notifies, and a sound plays", async () => {
	const context = await openPanel(granted, server, { path: "/n1" });
	const before = (await shown(context.worker)).length;
	await sendPrompt(context.panel, "do something long");
	await context.tab.send("Page.bringToFront");
	await context.panel.waitFor(`document.body.innerText.includes("w159")`, { timeoutMs: 40000 });
	await context.panel.waitFor(`!document.hasFocus()`, { timeoutMs: 2000 }).catch(() => undefined);
	await context.worker.waitFor(`chrome.notifications.getAll().then((all) => Object.keys(all).length > ${before})`, {
		timeoutMs: 5000,
	});
	assert.ok(await context.worker.evaluate(`chrome.offscreen.hasDocument()`), "the chime needs the offscreen document");
	await context.panel.close();
	await context.tab.close();
});

test("the user can turn notifications off", async () => {
	const worker = await granted.worker();
	const before = (await shown(worker)).length;
	await worker.evaluate(`chrome.storage.local.set({ notify_enabled: false })`);
	const harness = await Harness.connect(granted);
	assert.deepEqual(await harness.callText("notify_user", { title: "Silent" }), { shown: false });
	assert.equal((await shown(worker)).length, before);
	await worker.evaluate(`chrome.storage.local.remove("notify_enabled")`);
	await harness.close();
});

test("without the permission a long run offers notifications once", async () => {
	const plain = await Browser.launch();
	try {
		const context = await openPanel(plain, server, { path: "/n2" });
		assert.equal(
			await context.worker.evaluate(`chrome.permissions.contains({ permissions: ["notifications"] })`),
			false,
		);
		await sendPrompt(context.panel, "do something long");
		await context.panel.waitFor(`document.body.innerText.includes("Get a notification when tasks finish?")`, {
			timeoutMs: 40000,
		});
		await context.panel.evaluate(
			`[...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "Not now").click()`,
		);
		await context.panel.waitFor(`!document.body.innerText.includes("Get a notification when tasks finish?")`);
		await context.panel.send("Page.reload");
		await context.panel.waitFor(`document.body.innerText.includes("w159")`);
		assert.ok(!(await pageText(context.panel)).includes("Get a notification"));
	} finally {
		await plain.close();
	}
});
