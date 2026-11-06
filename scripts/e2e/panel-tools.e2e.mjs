// The panel agent's own tools on a minified build: page scripts are stringified functions, so
// this is what breaks first if bundling changes them.
// Run: SITEGEIST_VERSION=9.9.9 node scripts/build.mjs && npm run test:e2e

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { Browser, openPanel, sendPrompt, startFakeServer } from "./lib.mjs";

const page = `<!doctype html><title>Tool page</title><h1 id="h">Hello tools</h1><input id="i"><button onclick="document.title='clicked'">Go</button>
<input id="f" type="file" onchange="this.files[0].text().then((t) => { document.title = this.files[0].name + ':' + t; })">`;
let browser;
let server;
let turns;

before(async () => {
	server = await startFakeServer({
		routes: { "/tools": page, "/upload": page, "/gif": page },
		script: (body, index) => turns(body, index),
	});
	browser = await Browser.launch();
});

after(async () => {
	await browser.close();
	await server.close();
});

/** The tool result the model received for the call with this index, as text. */
function toolOutput(index) {
	const body = server.requests[index + 1];
	const tool = body.messages.filter((m) => m.role === "tool").at(-1);
	return typeof tool.content === "string" ? tool.content : JSON.stringify(tool.content);
}

test("navigate, repl with browserjs, and a screenshot all work", async () => {
	turns = (_body, index) => {
		if (index === 0) return { toolCalls: [{ name: "navigate", args: { url: `${server.origin}/tools` } }] };
		if (index === 1) {
			return {
				toolCalls: [
					{
						name: "repl",
						args: {
							title: "Read the page",
							code: `const r = await browserjs(() => document.querySelector("#h").textContent); console.log("heading:", r); return r;`,
						},
					},
				],
			};
		}
		if (index === 2) return { toolCalls: [{ name: "extract_image", args: { mode: "screenshot" } }] };
		return { text: "tools finished" };
	};
	const context = await openPanel(browser, server, { path: "/tools" });
	await sendPrompt(context.panel, "use your tools");
	await context.panel.waitFor(`document.body.innerText.includes("tools finished")`, { timeoutMs: 40000 });
	assert.ok(toolOutput(0).includes("Tool page"), toolOutput(0).slice(0, 200));
	assert.ok(toolOutput(1).includes("Hello tools"), toolOutput(1).slice(0, 300));
	const shot = JSON.stringify(server.requests[3].messages);
	assert.ok(shot.includes("image_url") || shot.includes("data:image"), "the screenshot must reach the model");
	await context.panel.close();
	await context.tab.close();
});

test("upload_file hands an artifact to the page", async () => {
	server.requests.length = 0;
	turns = (_body, index) => {
		if (index === 0)
			return {
				toolCalls: [
					{ name: "artifacts", args: { command: "create", filename: "notes.txt", content: "from the chat" } },
				],
			};
		if (index === 1) return { toolCalls: [{ name: "upload_file", args: { name: "notes.txt" } }] };
		return { text: "uploaded it" };
	};
	const context = await openPanel(browser, server, { path: "/upload" });
	await sendPrompt(context.panel, "upload the notes");
	await context.panel.waitFor(`document.body.innerText.includes("uploaded it")`, { timeoutMs: 20000 });
	assert.ok(toolOutput(1).includes("delivered"), toolOutput(1).slice(0, 200));
	await context.tab.waitFor(`document.title === "notes.txt:from the chat"`);
	await context.panel.close();
	await context.tab.close();
});

test("gif_creator works from the panel", async () => {
	server.requests.length = 0;
	turns = (_body, index) => {
		if (index === 0) return { toolCalls: [{ name: "gif_creator", args: { action: "start_recording" } }] };
		if (index === 1) return { toolCalls: [{ name: "gif_creator", args: { action: "stop_recording" } }] };
		if (index === 2)
			return { toolCalls: [{ name: "gif_creator", args: { action: "export", filename: "demo.gif" } }] };
		return { text: "recorded it" };
	};
	const context = await openPanel(browser, server, { path: "/gif" });
	await sendPrompt(context.panel, "record");
	await context.panel.waitFor(`document.body.innerText.includes("recorded it")`, { timeoutMs: 30000 });
	assert.match(toolOutput(2), /Saved demo\.gif to Downloads \(\d+ frames/);
	await context.panel.close();
	await context.tab.close();
});
