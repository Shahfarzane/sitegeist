// The panel agent's own tools on a minified build: page scripts are stringified functions, so
// this is what breaks first if bundling changes them.
// Run: SITEGEIST_VERSION=9.9.9 node scripts/build.mjs && npm run test:e2e

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { Browser, idbPutSource, openPanel, sendPrompt, startFakeServer } from "./lib.mjs";

const page = `<!doctype html><title>Tool page</title><h1 id="h">Hello tools</h1><input id="i"><button onclick="document.title='clicked'">Go</button>
<input id="f" type="file" onchange="this.files[0].text().then((t) => { document.title = this.files[0].name + ':' + t; })">`;
let browser;
let server;
let turns;

before(async () => {
	server = await startFakeServer({
		routes: {
			"/tools": page,
			"/upload": page,
			"/gif": page,
			"/devtools": `<!doctype html><title>Dev</title><h1>Dev</h1>`,
		},
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

test("read_console and read_network show what the page does", async () => {
	server.requests.length = 0;
	turns = (_body, index) => {
		if (index === 0) return { toolCalls: [{ name: "read_console", args: {} }] };
		if (index === 1) return { toolCalls: [{ name: "read_network", args: {} }] };
		if (index === 2) {
			return {
				toolCalls: [
					{
						name: "repl",
						args: {
							title: "Make noise",
							code: `await browserjs(() => { console.error("broken thing"); return fetch("/devtools").then((r) => r.status); }); return "ok";`,
						},
					},
				],
			};
		}
		if (index === 3) return { toolCalls: [{ name: "read_console", args: { onlyErrors: true } }] };
		if (index === 4) return { toolCalls: [{ name: "read_network", args: { urlPattern: "devtools" } }] };
		return { text: "debugged" };
	};
	const context = await openPanel(browser, server, { path: "/devtools" });
	await sendPrompt(context.panel, "debug this");
	await context.panel.waitFor(`document.body.innerText.includes("debugged")`, { timeoutMs: 20000 });
	assert.ok(toolOutput(3).includes("broken thing"), toolOutput(3).slice(0, 200));
	assert.match(toolOutput(4), /GET 200 .*devtools/);
	await context.panel.close();
	await context.tab.close();
});

test("a saved prompt shows in the / menu and goes in as text", async () => {
	server.requests.length = 0;
	turns = () => ({ text: "prompt answered" });
	const context = await openPanel(browser, server, { path: "/prompts" });
	await context.panel.evaluate(`${idbPutSource}
		window.__idbPut("prompts", "summarize-page", { name: "summarize-page", text: "Summarize this page in five bullets.", createdAt: "2026-01-01" })`);
	await context.panel.evaluate(`(() => {
		const ta = document.querySelector("message-editor textarea");
		ta.focus();
		ta.value = "/summ";
		ta.selectionStart = ta.selectionEnd = 5;
		ta.dispatchEvent(new Event("input", { bubbles: true }));
	})()`);
	await context.panel.waitFor(`document.body.innerText.includes("summarize-page")`);
	await context.panel.send("Input.dispatchKeyEvent", {
		type: "keyDown",
		key: "Enter",
		code: "Enter",
		windowsVirtualKeyCode: 13,
		text: "\\r",
	});
	await context.panel.send("Input.dispatchKeyEvent", {
		type: "keyUp",
		key: "Enter",
		code: "Enter",
		windowsVirtualKeyCode: 13,
	});
	await context.panel.waitFor(
		`document.querySelector("message-editor textarea").value.startsWith("Summarize this page")`,
	);
	await sendPrompt(
		context.panel,
		await context.panel.evaluate(`document.querySelector("message-editor textarea").value`),
	);
	await context.panel.waitFor(`document.body.innerText.includes("prompt answered")`);
	assert.ok(JSON.stringify(server.requests[0].messages).includes("Summarize this page in five bullets."));
	await context.panel.close();
	await context.tab.close();
});

test("the welcome screen offers what fits the page", async () => {
	const context = await openPanel(browser, server, { path: "/welcome" });
	await context.panel.waitFor(`document.body.innerText.includes("Summarize this page")`);
	await context.panel.close();
	await context.tab.close();
});

test("the right-click menu exists and its question lands in the composer", async () => {
	const context = await openPanel(browser, server, { path: "/menu" });
	await context.worker.evaluate(`chrome.contextMenus.update("sitegeist-ask-page", { visible: true })`);
	await context.worker.evaluate(`chrome.contextMenus.update("sitegeist-ask-selection", { visible: true })`);
	await context.worker.evaluate(`chrome.storage.session.set({ panel_prefill_${context.tabId}: "About this page: " })`);
	await context.panel.waitFor(`document.querySelector("message-editor textarea").value === "About this page: "`);
	await context.panel.close();
	await context.tab.close();
});

test("capture an area attaches the dragged part of the page", async () => {
	const context = await openPanel(browser, server, { path: "/region" });
	await context.tab.send("Page.bringToFront");
	await context.panel.evaluate(`document.querySelector("overflow-menu button").click()`);
	await context.panel.waitFor(
		`[...document.querySelectorAll("button,[role=menuitem]")].some((b) => b.textContent.trim() === "Capture an area")`,
	);
	await context.panel.evaluate(
		`[...document.querySelectorAll("button,[role=menuitem]")].find((b) => b.textContent.trim() === "Capture an area").click()`,
	);
	await context.tab.waitFor(`document.documentElement.lastElementChild?.textContent.includes("Drag to select")`, {
		timeoutMs: 8000,
	});
	const mouse = (type, x, y) =>
		context.tab.send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 });
	await mouse("mousePressed", 10, 10);
	await mouse("mouseMoved", 120, 60);
	await mouse("mouseReleased", 210, 110);
	await context.panel.waitFor(`document.querySelector("message-editor")?.attachments?.length === 1`, {
		timeoutMs: 8000,
	});
	const attachment = await context.panel.evaluate(
		`(() => { const a = document.querySelector("message-editor").attachments[0]; return { name: a.fileName, type: a.mimeType, size: a.size }; })()`,
	);
	assert.equal(attachment.name, "region.png");
	assert.equal(attachment.type, "image/png");
	assert.ok(attachment.size > 100);
	assert.ok(
		!(await context.tab.evaluate(`document.body.innerText`)).includes("Drag to select"),
		"the overlay must be gone",
	);
	await context.panel.close();
	await context.tab.close();
});
