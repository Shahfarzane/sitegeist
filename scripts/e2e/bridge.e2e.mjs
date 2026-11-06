// The bridge on the real path: MCP client, `sitegeist mcp`, socket, native host, extension.
// Run: SITEGEIST_VERSION=9.9.9 node scripts/build.mjs && (cd cli && npm run build) && npm run test:e2e

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { Browser, bridgeReady, Harness, startFakeServer } from "./lib.mjs";

let browser;
let server;
let harness;

const form = `<!doctype html><title>Form</title>
<form id="f" onsubmit="event.preventDefault(); document.title = 'sent:' + new FormData(this).get('name');">
	<label>Name <input name="name"></label>
	<label>Email <input name="email" type="email"></label>
	<label>Notes <textarea name="notes"></textarea></label>
	<label>Plan <select name="plan"><option>Free</option><option>Pro</option></select></label>
	<label><input type="checkbox" name="terms"> Terms</label>
	<button>Send</button>
</form>`;

const uploadPage = `<!doctype html><title>Upload</title>
<input id="hidden" type="file" multiple style="display:none" onchange="document.title = 'input:' + [...this.files].map((f) => f.name + ':' + f.size + ':' + f.type).join(',')">
<div id="zone" style="width:300px;height:200px;background:#eee"
	ondragover="event.preventDefault()"
	ondrop="event.preventDefault(); document.title = 'drop:' + [...event.dataTransfer.files].map((f) => f.name + ':' + f.size).join(',');">Drop here</div>`;

before(async () => {
	server = await startFakeServer({
		routes: { "/form": form, "/upload": uploadPage },
		script: () => ({ text: "unused" }),
	});
	browser = await Browser.launch({ bridge: true });
	await browser.worker();
	await bridgeReady(browser);
	harness = await Harness.connect(browser);
});

after(async () => {
	await harness?.close();
	await browser?.close();
	await server?.close();
});

test("the bridge drives a page end to end", async () => {
	const nav = await harness.callText("navigate", { url: `${server.origin}/form` });
	assert.equal(nav.title, "Form");
	const page = await harness.callText("read_page", {});
	assert.ok(page.includes("Send"));
});

test("a whole form takes two calls", async () => {
	const nav = await harness.callText("navigate", { url: `${server.origin}/form`, read: true });
	assert.ok(nav.includes("Send"), "navigate must return the page");
	const result = await harness.call("actions", {
		steps: [
			{ fill: { text: "Name", value: "Ada" } },
			{ fill: { text: "Email", value: "ada@example.test" } },
			{ fill: { text: "Notes", value: "hello" } },
			{ fill: { text: "Plan", value: "Pro" } },
			{ fill: { text: "Terms", value: "true" } },
			{ click: { text: "Send" } },
			{ wait: { text: "Name" } },
		],
		read: true,
	});
	const text = result.content.map((c) => c.text).join("\n");
	assert.ok(text.includes("sent:Ada"), text.slice(0, 300));
	const values = await harness.callText("run_js", {
		code: `({ plan: document.querySelector("select").value, terms: document.querySelector("[type=checkbox]").checked })`,
	});
	assert.deepEqual(values.value, { plan: "Pro", terms: true });
});

test("a target that does not exist says so", async () => {
	await assert.rejects(harness.call("click", { text: "No such button" }), /No element with the text/);
});

test("typing a long text", async () => {
	await harness.callText("navigate", { url: `${server.origin}/form` });
	const text = "word ".repeat(400).trim();
	const started = performance.now();
	await harness.callText("type", { text, selector: "textarea" });
	const elapsed = Math.round(performance.now() - started);
	const value = await harness.callText("run_js", { code: `document.querySelector("textarea").value` });
	assert.equal(value.value, text);
	assert.ok(elapsed < 500, `typed ${text.length} chars in ${elapsed} ms`);
});

test("a line break in long text stays a key press", async () => {
	await harness.callText("navigate", { url: `${server.origin}/form` });
	const text = `${"a".repeat(70)}\n${"b".repeat(70)}`;
	await harness.callText("type", { text, selector: "textarea" });
	const value = await harness.callText("run_js", { code: `document.querySelector("textarea").value` });
	assert.equal(value.value, text);
});

test("full access: nothing about raw CDP is refused", async () => {
	const result = await harness
		.callText("cdp", { method: "Storage.getStorageKey", params: {} })
		.catch((err) => err.message);
	assert.ok(!String(JSON.stringify(result)).includes("not available through the bridge"), JSON.stringify(result));
});

test("a browser that stored ask moves to full access once", async () => {
	const worker = await browser.worker();
	assert.equal(
		await worker.evaluate(
			`chrome.storage.local.get("bridge_full_access_applied").then((d) => d.bridge_full_access_applied)`,
		),
		true,
	);
	assert.notEqual(
		await worker.evaluate(`chrome.storage.local.get("bridge_permission_mode").then((d) => d.bridge_permission_mode)`),
		"ask",
	);
});

const title = async () => (await harness.callText("run_js", { code: "document.title" })).value;

test("file_upload fills a hidden file input, across the 1 MiB frame limit", async () => {
	const dir = mkdtempSync(join(tmpdir(), "sitegeist-e2e-upload-"));
	const big = join(dir, "report.pdf");
	const small = join(dir, "notes.txt");
	writeFileSync(big, Buffer.alloc(9 * 1024 * 1024, 7));
	writeFileSync(small, "hello");
	await harness.callText("navigate", { url: `${server.origin}/upload` });
	const result = await harness.callText("file_upload", { paths: [big, small] });
	assert.deepEqual(result, { delivered: "input", files: 2 });
	assert.equal(await title(), `input:report.pdf:${9 * 1024 * 1024}:application/pdf,notes.txt:5:text/plain`);
	rmSync(dir, { recursive: true, force: true });
});

test("file_upload drops onto a zone that has no input", async () => {
	const dir = mkdtempSync(join(tmpdir(), "sitegeist-e2e-upload-"));
	const file = join(dir, "pic.png");
	writeFileSync(file, Buffer.alloc(1000, 1));
	await harness.callText("navigate", { url: `${server.origin}/upload` });
	const result = await harness.callText("file_upload", { paths: [file], selector: "#zone" });
	assert.deepEqual(result, { delivered: "drop", files: 1 });
	assert.equal(await title(), "drop:pic.png:1000");
	rmSync(dir, { recursive: true, force: true });
});

test("upload_image sends a screenshot to the page", async () => {
	await harness.callText("navigate", { url: `${server.origin}/upload` });
	const shot = await harness.call("screenshot", {});
	const imageId = /imageId (\w+)/.exec(shot.content.at(-1).text)[1];
	await harness.callText("upload_image", { imageId, filename: "bug.jpg" });
	assert.match(await title(), /^input:bug\.jpg:\d+:image\/jpeg$/);
});

test("a screenshot id that is gone says so", async () => {
	await assert.rejects(harness.call("upload_image", { imageId: "nope" }), /take a new one/);
});
