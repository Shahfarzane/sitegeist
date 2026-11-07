// Chrome 154 to 157 platform changes: split view, policy errors, the HTTPS warning, script cancel.
// Run: npm test (node --import tsx --test).

import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { attachError, shownTabIds } from "../src/browser/cdp.ts";
import { CANCELLED_MESSAGE, injectScript, usableUserScripts } from "../src/browser/inject.ts";
import { navigationError } from "../src/browser/page.ts";

const g = globalThis as { chrome?: unknown };
afterEach(() => {
	g.chrome = undefined;
});

test("the other half of a split view counts as on screen", () => {
	const shown = shownTabIds([
		{ id: 1, active: true, splitViewId: 7 },
		{ id: 2, active: false, splitViewId: 7 },
		{ id: 3, active: false, splitViewId: -1 },
		{ id: 4, active: false, splitViewId: 9 },
		{ id: 5, active: true, splitViewId: -1 },
	]);
	assert.deepEqual([...shown].sort(), [1, 2, 5]);
});

test("a debugger attach refused by policy names the policy", () => {
	assert.match(attachError(3, "Host access is restricted by policy."), /runtime_blocked_hosts/);
	assert.match(attachError(3, "Screenshot capture is restricted by policy."), /DisableScreenshots/);
	assert.equal(attachError(3, "No tab with given id 3."), "Cannot attach to tab 3: No tab with given id 3.");
});

test("Chrome's warning before a plain http page is explained", () => {
	assert.match(navigationError("http://neverssl.com/", "http://neverssl.com/", "net::ERR_BLOCKED_BY_CLIENT"), /Not secure/);
	assert.equal(
		navigationError("https://x.test/", "https://x.test/", "net::ERR_BLOCKED_BY_CLIENT"),
		"Navigation to https://x.test/ failed: net::ERR_BLOCKED_BY_CLIENT",
	);
});

test("a revoked user scripts toggle reads as unavailable although execute still exists", async () => {
	g.chrome = {
		userScripts: {
			execute: async () => [],
			getScripts: () => {
				throw new Error("'userScripts.getScripts' is not available in this context.");
			},
		},
	};
	assert.equal(await usableUserScripts(), undefined);
	(g.chrome as { userScripts: { getScripts: () => Promise<unknown[]> } }).userScripts.getScripts = async () => [];
	assert.notEqual(await usableUserScripts(), undefined);
});

test("cancelling a script rejects at once and reloads a tab the script still blocks", async () => {
	const calls: string[] = [];
	g.chrome = {
		userScripts: {
			configureWorld: async () => undefined,
			getScripts: async () => [],
			execute: () => new Promise(() => undefined),
		},
		scripting: { executeScript: () => new Promise(() => undefined) },
		tabs: {
			discard: async (id: number) => {
				calls.push(`discard ${id}`);
			},
			reload: async (id: number) => {
				calls.push(`reload ${id}`);
			},
		},
	};
	const controller = new AbortController();
	const run = injectScript(5, "while (true) {}", { signal: controller.signal });
	setTimeout(() => controller.abort(), 20);
	const started = Date.now();
	await assert.rejects(run, new RegExp(CANCELLED_MESSAGE));
	assert.ok(Date.now() - started < 500, "the call must not wait for the page");
	await new Promise((r) => setTimeout(r, 1700));
	assert.deepEqual(calls, ["discard 5", "reload 5"]);
});

test("a cancelled script that let go of the page leaves the tab alone", async () => {
	const calls: string[] = [];
	g.chrome = {
		userScripts: {
			configureWorld: async () => undefined,
			getScripts: async () => [],
			execute: () => new Promise(() => undefined),
		},
		scripting: { executeScript: async () => [{ result: true }] },
		tabs: {
			discard: async () => calls.push("discard"),
			reload: async () => calls.push("reload"),
		},
	};
	const controller = new AbortController();
	const run = injectScript(5, "await new Promise(() => {})", { signal: controller.signal });
	controller.abort();
	await assert.rejects(run, new RegExp(CANCELLED_MESSAGE));
	await new Promise((r) => setTimeout(r, 50));
	assert.deepEqual(calls, []);
});
