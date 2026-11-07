// Page access through Chrome: file upload by path, the isolated world, browser-side console
// messages, response bodies and cross-origin iframes.
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
let dir;
let file;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

before(async () => {
	server = await startFakeServer({
		routes: {
			"/input": `<!doctype html><title>start</title><input type=file id=f
				onchange="document.title = 'input:' + event.isTrusted + ':' + [...this.files].map((f) => f.name + ':' + f.size)">`,
			"/button": `<!doctype html><title>start</title><button id=b onclick="document.getElementById('h').click()">Upload</button>
				<input type=file id=h style="display:none" onchange="document.title = 'chooser:' + this.files[0].name">`,
			"/drop": `<!doctype html><title>start</title><div id=z style="width:300px;height:200px;background:#ddd"
				ondragover="event.preventDefault()"
				ondrop="event.preventDefault(); document.title = 'drop:' + event.isTrusted + ':' + [...event.dataTransfer.files].map((f) => f.name)">Drop here</div>`,
			"/plain": "<!doctype html><title>Plain</title><p>plain</p>",
			"/broken": `<!doctype html><title>Broken</title><img src="/missing.png">`,
			"/api": `<!doctype html><title>Api</title><script>fetch("/data.json").then((r) => r.json()).then((d) => { document.title = "got " + d.answer; });</script>`,
			"/data.json": JSON.stringify({ answer: 42, items: ["a", "b"] }),
			// localhost and 127.0.0.1 are different sites, so the frame gets its own renderer.
			"/outer": () =>
				`<!doctype html><title>Outer</title><iframe src="${server.origin.replace("127.0.0.1", "localhost")}/inner"></iframe>`,
			"/inner": "<!doctype html><title>Inner</title><p id=secret>inside the frame</p>",
		},
		script: () => ({ text: "unused" }),
	});
	browser = await Browser.launch({ bridge: true });
	await browser.worker();
	await bridgeReady(browser);
	harness = await Harness.connect(browser);
	dir = mkdtempSync(join(tmpdir(), "sitegeist-e2e-upload-"));
	file = join(dir, "report.txt");
	writeFileSync(file, "hello upload");
});

after(async () => {
	await harness?.close();
	await browser?.close();
	await server?.close();
	if (dir) rmSync(dir, { recursive: true, force: true });
});

const title = async () => (await harness.callText("run_js", { code: "document.title", world: "main" })).value;

test("the debugger path keeps its helpers out of the page's reach", async () => {
	await harness.callText("navigate", { url: `${server.origin}/plain` });
	assert.equal((await harness.callText("run_js", { code: "document.title" })).value, "Plain");
	const leaked = await harness.callText("run_js", {
		code: "[typeof window.__sitegeistPending, typeof window.__sitegeistSend, typeof window.__sitegeistRefs]",
		world: "main",
	});
	assert.deepEqual(leaked.value, ["undefined", "undefined", "undefined"]);
	const page = await harness.callText("read_page", {});
	assert.ok(page.includes("plain"), "snapshots still work in the isolated world");
});

test("browser-side messages show in the console capture", async () => {
	await harness.callText("navigate", { url: `${server.origin}/broken` });
	await sleep(300);
	const result = await harness.call("read_console", {});
	const text = result.content.map((c) => c.text).join("\n");
	assert.match(text, /missing\.png/, text.slice(0, 500));
});

test("read_network returns a response body", async () => {
	await harness.callText("navigate", { url: `${server.origin}/plain` });
	await harness.callText("read_network", {});
	await harness.callText("navigate", { url: `${server.origin}/api` });
	await sleep(500);
	assert.equal(await title(), "got 42");
	const { entries } = await harness.callText("read_network", { urlPattern: "data\\.json", body: true });
	assert.equal(entries.length, 1, JSON.stringify(entries));
	assert.deepEqual(JSON.parse(entries[0].body), { answer: 42, items: ["a", "b"] });
});

test("run_js reaches into a cross-origin iframe", async () => {
	await harness.callText("navigate", { url: `${server.origin}/outer` });
	await sleep(500);
	const inner = await harness.callText("run_js", {
		code: "document.getElementById('secret').textContent",
		frame: "/inner",
	});
	assert.equal(inner.value, "inside the frame");
	await assert.rejects(harness.call("run_js", { code: "1", frame: "/nope" }), /Frames: .*\/inner/);
});

/**
 * Unpacked builds start with "Allow access to file URLs" on. Turning it off cannot be tested
 * here: Chrome disables a --load-extension build when its file access changes
 * (unsupportedDeveloperExtension), so the page-script fallback is covered by upload_image.
 */
async function uploadTo(path, args) {
	await harness.callText("navigate", { url: `${server.origin}${path}` });
	return harness.callText("file_upload", { paths: [file], ...args });
}

test("with file URL access, Chrome takes the files: input, upload button and drop zone", async () => {
	const input = await uploadTo("/input", {});
	assert.equal(input.delivered, "input");
	assert.equal(await title(), "input:true:report.txt:12");

	const chooser = await uploadTo("/button", { text: "Upload" });
	assert.equal(chooser.delivered, "chooser");
	assert.equal(await title(), "chooser:report.txt");

	const drop = await uploadTo("/drop", { selector: "#z" });
	assert.equal(drop.delivered, "drop");
	assert.equal(await title(), "drop:true:report.txt");
});
