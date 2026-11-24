// The store copy and a dev copy in one browser profile, as both run on a Mac: each on its own
// bridge, and neither breaking up the other's agent tab groups when it starts or reloads.
// Run: npm run build && npm run build:dev && (cd cli && npm run build) && npm run test:e2e

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { readChannel } from "../channel-build.mjs";
import { Browser, bridgeReady, Harness, repoRoot, startFakeServer } from "./lib.mjs";

const NAMES = ["production", "dev"];
const missing = NAMES.filter((name) => {
	const { channel } = readChannel(repoRoot, name);
	return (
		!existsSync(join(repoRoot, channel.outDir, "manifest.json")) ||
		!existsSync(join(repoRoot, "cli", channel.cliOutDir, "index.js"))
	);
});
const skip =
	missing.length > 0 &&
	`not built: ${missing.join(", ")} (npm run build && npm run build:dev && (cd cli && npm run build))`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const page = "<!doctype html><title>Fixture</title><h1>Fixture</h1>";

let browser;
let server;
const agents = {};

/** The groups of the whole profile with their tabs' paths, read from one copy's worker. */
async function groups() {
	const worker = await browser.worker({ id: browser.channels.production.id });
	return worker.evaluate(`(async () => {
		const groups = await chrome.tabGroups.query({});
		return Promise.all(groups.map(async (g) => ({
			id: g.id,
			title: g.title,
			paths: (await chrome.tabs.query({ groupId: g.id })).map((t) => new URL(t.url).pathname),
		})));
	})()`);
}

/** Until no target has `targetId` any more. */
async function gone(targetId, timeoutMs = 15000) {
	const deadline = Date.now() + timeoutMs;
	while ((await browser.targets()).some((t) => t.targetId === targetId)) {
		if (Date.now() > deadline) throw new Error(`target ${targetId} is still there`);
		await sleep(100);
	}
}

/** Reloads one copy as a rebuild does, and waits until its new worker has run its start-up cleanup. */
async function reload(name) {
	const { id } = browser.channels[name];
	const worker = await browser.worker({ id });
	await worker.evaluate("chrome.runtime.reload()").catch(() => undefined);
	await gone(worker.targetId);
	const fresh = await browser.worker({ id, timeoutMs: 20000 });
	await fresh.waitFor("chrome.tabGroups !== undefined");
	// cleanupOrphanGroups runs at the top of the worker; give its tab calls time to land.
	await sleep(1500);
}

before(async () => {
	if (skip) return;
	server = await startFakeServer({ routes: { "/production-task": page, "/dev-task": page } });
	browser = await Browser.launch({ channels: NAMES });
	// An unpacked copy reloads only in developer mode, as in a real browser; without it the reload unloads it.
	const extensions = await browser.open("chrome://extensions/");
	await extensions.waitFor("!!chrome.developerPrivate");
	await extensions.evaluate(
		"new Promise((resolve) => chrome.developerPrivate.updateProfileConfiguration({ inDeveloperMode: true }, resolve))",
	);
	await extensions.close();
	for (const name of NAMES) {
		const { id, socketDir, cli } = browser.channels[name];
		await browser.worker({ id });
		await bridgeReady(browser, 20000, socketDir);
		agents[name] = await Harness.connect(browser, { name: `${name}-agent`, session: name, socketDir, cli });
	}
});

after(async () => {
	for (const agent of Object.values(agents)) await agent.close().catch(() => undefined);
	await browser?.close();
	await server?.close();
});

test("each copy is on its own bridge, and each CLI reaches only its own copy", { skip }, async () => {
	for (const name of NAMES) {
		const { socketDir, cli } = browser.channels[name];
		const listed = execFileSync(process.execPath, [cli, "browsers"], {
			encoding: "utf8",
			env: { ...process.env, SITEGEIST_SOCKET_DIR: socketDir },
		})
			.trim()
			.split("\n");
		assert.equal(listed.length, 1, `${name}: ${listed.join(" | ")}`);
		assert.match(listed[0], /extension connected/);
	}
	await agents.production.callText("navigate", { url: `${server.origin}/production-task`, read: false });
	await agents.dev.callText("navigate", { url: `${server.origin}/dev-task`, read: false });
	const all = await groups();
	// The prefix is written by the extension that made the group: each agent landed on its own copy.
	const production = all.find((g) => g.paths.includes("/production-task"));
	const dev = all.find((g) => g.paths.includes("/dev-task"));
	assert.match(production?.title ?? "", /^Sitegeist · /, JSON.stringify(all));
	assert.match(dev?.title ?? "", /^Sitegeist dev · /, JSON.stringify(all));
	assert.notEqual(production.id, dev.id);
});

test("a dev reload leaves the production agent's tab group in place", { skip }, async () => {
	const before = (await groups()).find((g) => g.paths.includes("/production-task"));
	assert.ok(before, "the production agent has a group");
	await reload("dev");
	const after = (await groups()).find((g) => g.id === before.id);
	assert.deepEqual(after, before);
	// The production agent still drives its tab.
	const context = await agents.production.callText("tabs_context", {});
	assert.match(JSON.stringify(context), /production-task/);
});

test("a production reload leaves the dev agent's tab group in place", { skip }, async () => {
	const before = (await groups()).find((g) => g.paths.includes("/dev-task"));
	assert.ok(before, "the dev agent has a group");
	await reload("production");
	const after = (await groups()).find((g) => g.id === before.id);
	assert.deepEqual(after, before);
	const context = await agents.dev.callText("tabs_context", {});
	assert.match(JSON.stringify(context), /dev-task/);
});

test("the store copy keeps its shortcut; the dev copy asks for none", { skip }, async () => {
	const shortcut = async (name) => {
		const worker = await browser.worker({ id: browser.channels[name].id });
		const commands = await worker.evaluate("chrome.commands.getAll()");
		return commands.find((c) => c.name === "toggle-sidepanel")?.shortcut;
	};
	assert.ok(await shortcut("production"), "production has Command+Shift+S");
	assert.equal(await shortcut("dev"), "");
});
