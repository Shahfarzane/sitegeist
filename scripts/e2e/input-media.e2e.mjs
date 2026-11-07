// Keys, page dialogs and recordings on the real bridge path (Chrome 154 to 157 CDP features).
// Run: SITEGEIST_VERSION=9.9.9 node scripts/build.mjs && (cd cli && npm run build) && npm run test:e2e

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { Browser, bridgeReady, Harness, startFakeServer } from "./lib.mjs";

let browser;
let server;
let harness;
let outDir;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const pages = {
	"/text": "<!doctype html><title>Text</title><textarea id=t>hello world</textarea>",
	"/dialogs": `<!doctype html><title>start</title>
<button id=c onclick="document.title = confirm('Delete it?') ? 'yes' : 'no'">Confirm</button>
<button id=p onclick="document.title = 'name:' + prompt('Your name?', 'nobody')">Prompt</button>
<button id=a onclick="alert('Saved'); document.title = 'after alert'">Alert</button>`,
	"/anim": `<!doctype html><title>Anim</title><div id=b style="position:absolute;width:60px;height:60px;background:#c33"></div>
<script>let x = 0; setInterval(() => { x = (x + 9) % 900; document.getElementById("b").style.left = x + "px"; }, 16);</script>`,
	"/tall": `<!doctype html><title>Tall</title><div style="height:4000px">tall</div>`,
};

before(async () => {
	server = await startFakeServer({ routes: pages, script: () => ({ text: "unused" }) });
	browser = await Browser.launch({ bridge: true });
	await browser.worker();
	await bridgeReady(browser);
	harness = await Harness.connect(browser);
	outDir = mkdtempSync(join(tmpdir(), "sitegeist-e2e-media-"));
});

after(async () => {
	await harness?.close();
	await browser?.close();
	await server?.close();
	if (outDir) rmSync(outDir, { recursive: true, force: true });
});

const value = async (code) => (await harness.callText("run_js", { code, world: "main" })).value;

test("Cmd+A selects all text in a field on macOS", { skip: process.platform !== "darwin" }, async () => {
	await harness.callText("navigate", { url: `${server.origin}/text` });
	await harness.callText("click", { selector: "#t" });
	await harness.callText("press", { key: "Meta+a" });
	assert.equal(
		await value("(() => { const t = document.getElementById('t'); return t.selectionEnd - t.selectionStart; })()"),
		11,
	);
});

test("a confirm() is answered at once and reported with the result", async () => {
	await harness.callText("navigate", { url: `${server.origin}/dialogs` });
	const result = await harness.callText("click", { selector: "#c" });
	assert.equal(await value("document.title"), "yes");
	assert.deepEqual(
		result.dialogs?.map((d) => [d.type, d.message, d.accepted]),
		[["confirm", "Delete it?", true]],
	);
});

test("handle_dialog dismisses the next confirm and answers a prompt", async () => {
	await harness.callText("navigate", { url: `${server.origin}/dialogs` });
	await harness.callText("handle_dialog", { accept: false });
	await harness.callText("click", { selector: "#c" });
	assert.equal(await value("document.title"), "no");
	await harness.callText("handle_dialog", { accept: true, promptText: "Ada" });
	await harness.callText("click", { selector: "#p" });
	assert.equal(await value("document.title"), "name:Ada");
});

test("an alert() does not wedge the tab", async () => {
	await harness.callText("navigate", { url: `${server.origin}/dialogs` });
	await harness.callText("click", { selector: "#a" });
	assert.equal(await value("document.title"), "after alert");
});

test("a 4 fps recording of an animating page keeps close to 4 frames a second", async () => {
	await harness.callText("navigate", { url: `${server.origin}/anim` });
	await harness.callText("gif_creator", { action: "clear" });
	await harness.callText("gif_creator", { action: "start_recording" });
	await sleep(3000);
	const stopped = await harness.callText("gif_creator", { action: "stop_recording" });
	// Three seconds at 4 fps plus the start and end stills; three frames in flight gave about 36.
	assert.ok(stopped.frames >= 6 && stopped.frames <= 18, `frames: ${stopped.frames}`);
	await harness.callText("gif_creator", { action: "clear" });
});

test("record_video writes an MP4 of a hidden tab", async () => {
	await harness.callText("navigate", { url: `${server.origin}/anim` });
	await harness.callText("record_video", { action: "start" });
	await sleep(1500);
	const path = join(outDir, "clip.mp4");
	const result = await harness.callText("record_video", { action: "stop", path });
	assert.equal(result.path, path);
	const head = readFileSync(path).subarray(4, 8).toString("latin1");
	assert.equal(head, "ftyp");
});

test("the agent viewport has no scrollbar gutter", async () => {
	await harness.callText("navigate", { url: `${server.origin}/tall` });
	assert.equal(await value("document.documentElement.clientWidth"), 1280);
});
