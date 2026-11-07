// Downloads for agents: off until the user grants the optional permission, then a list of what pages saved.
// Run: SITEGEIST_VERSION=9.9.9 node scripts/build.mjs && (cd cli && npm run build) && npm run test:e2e

import assert from "node:assert/strict";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { Browser, bridgeReady, Harness, repoRoot, startFakeServer } from "./lib.mjs";

let server;
const cleanup = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

before(async () => {
	server = await startFakeServer({
		routes: {
			"/save": `<!doctype html><title>Save</title><a id=dl href="/report.csv" download="report.csv">Download</a>`,
			"/report.csv": "a,b\n1,2\n",
		},
		script: () => ({ text: "unused" }),
	});
});

after(async () => {
	for (const fn of cleanup.reverse()) await fn();
	await server?.close();
});

async function start(extensionDir) {
	const browser = await Browser.launch({ bridge: true, ...(extensionDir ? { extensionDir } : {}) });
	cleanup.push(() => browser.close());
	await browser.worker();
	await bridgeReady(browser);
	const harness = await Harness.connect(browser);
	cleanup.push(() => harness.close());
	return { browser, harness };
}

test("list_downloads says how to turn it on while the permission is off", async () => {
	const { harness } = await start();
	await assert.rejects(harness.call("list_downloads", {}), /Settings > Downloads/);
});

test("with downloads granted, an agent finds the file a click saved", async () => {
	// The permission is optional; this copy asks for it up front.
	const copy = mkdtempSync(join(tmpdir(), "sitegeist-e2e-ext-"));
	cleanup.push(() => rmSync(copy, { recursive: true, force: true }));
	cpSync(process.env.SITEGEIST_E2E_EXTENSION ?? join(repoRoot, "dist-chrome"), copy, { recursive: true });
	const manifest = JSON.parse(readFileSync(join(copy, "manifest.json"), "utf8"));
	manifest.permissions.push("downloads");
	writeFileSync(join(copy, "manifest.json"), JSON.stringify(manifest));
	const { browser, harness } = await start(copy);
	const folder = mkdtempSync(join(tmpdir(), "sitegeist-e2e-dl-"));
	cleanup.push(() => rmSync(folder, { recursive: true, force: true }));
	await browser.cdp.send("Browser.setDownloadBehavior", {
		behavior: "allow",
		downloadPath: folder,
		eventsEnabled: false,
	});
	await harness.callText("navigate", { url: `${server.origin}/save` });
	await harness.callText("click", { selector: "#dl" });
	let found;
	for (let i = 0; i < 20 && !found; i++) {
		await sleep(250);
		const { downloads } = await harness.callText("list_downloads", {});
		found = downloads.find((d) => d.path.endsWith("report.csv") && d.state === "complete");
	}
	assert.ok(found, "the download shows up as complete");
	assert.equal(found.url, `${server.origin}/report.csv`);
	assert.ok(existsSync(found.path));
	assert.equal(readFileSync(found.path, "utf8"), "a,b\n1,2\n");
});
