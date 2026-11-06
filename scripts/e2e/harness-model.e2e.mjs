// New chats open on the model the coding CLI is set to, until the user picks one in the panel.
// Run: SITEGEIST_VERSION=9.9.9 node scripts/build.mjs && (cd cli && npm run build) && npm run test:e2e

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { Browser, bridgeReady, composerReady, idbPutSource, openPanel, startFakeServer } from "./lib.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The stored key is fake and model discovery must not reach the real provider.
const offline = `{
	const real = window.fetch;
	window.fetch = (input, ...rest) =>
		String(input?.url ?? input).includes("anthropic.com") ? Promise.reject(new Error("offline")) : real(input, ...rest);
}`;

const label = `(document.querySelector("message-editor button span.truncate")?.textContent ?? "")`;

let browser;
let server;
let context;
let dir;

const newChat = async () => {
	await context.panel.send("Page.navigate", { url: `${context.url}&new=true` });
	await composerReady(context.panel);
};

before(async () => {
	dir = mkdtempSync(join(tmpdir(), "harness-model-"));
	writeFileSync(join(dir, "settings.json"), JSON.stringify({ model: "opus[1m]" }));
	server = await startFakeServer({
		routes: { "/page": "<!doctype html><title>Fixture</title><h1>Fixture</h1>" },
		script: () => ({ text: "ok" }),
	});
	browser = await Browser.launch({ bridge: true, env: { CLAUDE_CONFIG_DIR: dir, CODEX_HOME: dir } });
	await browser.worker();
	await bridgeReady(browser);
	context = await openPanel(browser, server, { init: offline });
	const sonnet = { ...context.model, provider: "anthropic", id: "claude-sonnet-4-6" };
	await context.panel.evaluate(`${idbPutSource}
		(async () => {
			await window.__idbPut("provider-keys", "anthropic", "test-key");
			await window.__idbPut("settings", "lastUsedModel", ${JSON.stringify(sonnet)});
		})()`);
});

after(async () => {
	await browser.close();
	await server.close();
	rmSync(dir, { recursive: true, force: true });
});

test("a new chat opens on the model the CLI is set to", async () => {
	await newChat();
	await context.panel.waitFor(`${label}.startsWith("claude-opus")`);
});

test("a model from another provider stays: it was someone's choice", async () => {
	await context.panel.evaluate(`${idbPutSource}
		window.__idbPut("settings", "lastUsedModel", ${JSON.stringify(context.model)})`);
	await newChat();
	await sleep(1500);
	assert.equal(await context.panel.evaluate(label), "fake-model");
	const sonnet = { ...context.model, provider: "anthropic", id: "claude-sonnet-4-6" };
	await context.panel.evaluate(`${idbPutSource}
		window.__idbPut("settings", "lastUsedModel", ${JSON.stringify(sonnet)})`);
	await newChat();
	await context.panel.waitFor(`${label}.startsWith("claude-opus")`);
});

test("a model picked in the panel beats the CLI from then on", async () => {
	const { panel } = context;
	await panel.evaluate(`document.querySelector("message-editor button span.truncate").click()`);
	await panel.waitFor(`document.body.innerText.includes("Select Model")`);
	await panel.evaluate(`[...document.querySelectorAll("*")]
		.filter((el) => el.children.length === 0 && el.textContent.trim() === "fake-model")
		.at(-1)
		.click()`);
	await panel.waitFor(`${label} === "fake-model"`);
	await sleep(300);
	await newChat();
	await sleep(1500);
	assert.equal(await panel.evaluate(label), "fake-model");
});
