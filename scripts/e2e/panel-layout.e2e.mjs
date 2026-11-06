// The panel's layout contract at side panel widths: the first frame has the final header and
// composer, nothing shifts while the bundle, font and suggestions load, only the chat scrolls,
// and padding and gaps stay on the 4 px scale.
// Run: SITEGEIST_VERSION=9.9.9 node scripts/build.mjs && npm run test:e2e

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { Browser, composerReady, openPanel, seedChat, startFakeServer } from "./lib.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Runs before the page's own scripts. rAF cannot fire until the stylesheet has unblocked
// rendering, so the shell measured here is the frame the user first sees.
const init = `
	window.__shifts = 0;
	new PerformanceObserver((list) => {
		for (const entry of list.getEntries()) if (!entry.hadRecentInput) window.__shifts += entry.value;
	}).observe({ type: "layout-shift", buffered: true });
	document.addEventListener("readystatechange", () => {
		if (document.readyState !== "interactive") return;
		requestAnimationFrame(() => {
			const shell = document.getElementById("boot-shell");
			if (!shell) return;
			const box = (el) => { const r = el.getBoundingClientRect(); return [r.left, r.top, r.width, r.height]; };
			window.__shell = { header: box(shell.children[0]), composer: box(shell.children[2].children[1]) };
		});
	});
`;

const finalGeometry = `(() => {
	const box = (el) => { const r = el.getBoundingClientRect(); return [r.left, r.top, r.width, r.height]; };
	return { header: box(document.querySelector("div.h-11")), composer: box(document.querySelector("message-editor").firstElementChild) };
})()`;

const offScale = `(() => {
	const allowed = new Set([0, 4, 8, 12, 16, 24, 32]);
	const found = new Set();
	for (const el of document.querySelectorAll("body *")) {
		if (el.closest(".markdown-content, code-block, svg, canvas")) continue;
		const style = getComputedStyle(el);
		if (style.display === "none") continue;
		for (const side of ["paddingTop", "paddingRight", "paddingBottom", "paddingLeft", "rowGap", "columnGap"]) {
			const value = Number.parseFloat(style[side]);
			if (!Number.isNaN(value) && !allowed.has(value)) {
				found.add(side + " " + style[side] + " on " + el.tagName.toLowerCase() + "." + String(el.className.baseVal ?? el.className).slice(0, 80));
			}
		}
	}
	return [...found];
})()`;

const click = (panel, text, scope = "button,[role=menuitem]") =>
	panel.evaluate(
		`[...document.querySelectorAll(${JSON.stringify(scope)})].find((b) => b.textContent.includes(${JSON.stringify(text)})).click()`,
	);

const longChat = Array.from({ length: 24 }, (_, i) =>
	i % 2 === 0
		? { role: "user", content: `Question ${i}`, timestamp: 1 }
		: {
				role: "assistant",
				content: [
					{ type: "text", text: `Answer ${i}. ${"This line makes the chat long enough to scroll. ".repeat(6)}` },
				],
				api: "openai-completions",
				provider: "fake",
				model: "fake-model",
				usage: {
					input: 1,
					output: 1,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 2,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: 1,
			},
);

let browser;
let server;
let context;

async function load(width, query = "&new=true") {
	const { panel, url } = context;
	await panel.send("Emulation.setDeviceMetricsOverride", { width, height: 800, deviceScaleFactor: 1, mobile: false });
	await panel.send("Page.navigate", { url: `${url}${query}` });
	await composerReady(panel);
	// Long enough for the provider check, suggestions and font swap to land.
	await sleep(1500);
}

before(async () => {
	server = await startFakeServer({
		routes: { "/page": "<!doctype html><title>Layout fixture</title><h1>Layout fixture</h1>" },
		script: () => ({ text: "ok" }),
	});
	browser = await Browser.launch();
	context = await openPanel(browser, server, { init });
});

after(async () => {
	await browser.close();
	await server.close();
});

for (const width of [360, 400, 500]) {
	test(`nothing moves on load at ${width} px`, async () => {
		await load(width);
		const { panel } = context;
		const shell = await panel.evaluate("window.__shell");
		assert.ok(shell, "the shell was on screen for the first frame");
		assert.deepEqual(await panel.evaluate(finalGeometry), shell);
		assert.equal(await panel.evaluate("window.__shifts"), 0);
		assert.equal(await panel.evaluate("document.documentElement.scrollWidth <= innerWidth"), true);
	});
}

test("a long model name truncates instead of pushing the send button out", async () => {
	await load(360);
	const { panel } = context;
	const inside = await panel.evaluate(`(() => {
		const label = [...document.querySelectorAll("message-editor button span")].find((s) => s.textContent === "fake-model");
		label.textContent = "a-very-long-provider-prefix/a-very-long-model-name-with-a-date-2026-11-06-preview";
		const composer = document.querySelector("message-editor").firstElementChild.getBoundingClientRect();
		const send = document.querySelector('message-editor button[title="Send"]').getBoundingClientRect();
		return send.right <= composer.right - 8 && send.width === 32;
	})()`);
	assert.equal(inside, true);
	assert.equal(await panel.evaluate("document.documentElement.scrollWidth <= innerWidth"), true);
});

test("the shift check can fail", async () => {
	await load(400);
	const { panel } = context;
	await panel.evaluate(
		`Object.assign(document.querySelector("message-editor").style, { position: "relative", top: "48px" })`,
	);
	await sleep(300);
	assert.ok((await panel.evaluate("window.__shifts")) > 0);
});

test("the bundled font renders the panel", async () => {
	await load(400);
	const { panel } = context;
	assert.equal(await panel.evaluate(`document.fonts.check('14px "Public Sans"')`), true);
	assert.match(await panel.evaluate(`getComputedStyle(document.body).fontFamily`), /^"?Public Sans/);
});

test("a long chat scrolls and the header and composer stay put", async () => {
	const { panel } = context;
	await panel.send("Emulation.setDeviceMetricsOverride", {
		width: 400,
		height: 800,
		deviceScaleFactor: 1,
		mobile: false,
	});
	await seedChat(context, "layout-long-chat", longChat, "Long chat");
	await panel.waitFor(`document.body.innerText.includes("Answer 23")`);
	await sleep(800);
	const shell = await panel.evaluate("window.__shell");
	const scroll = `(() => {
		const chat = document.querySelector("agent-interface .overflow-y-auto");
		return { page: document.documentElement.scrollHeight - innerHeight, chat: chat.scrollHeight - chat.clientHeight };
	})()`;
	const { page, chat } = await panel.evaluate(scroll);
	assert.equal(page, 0, "the page itself never scrolls");
	assert.ok(chat > 0, "the chat does");
	assert.deepEqual(await panel.evaluate(finalGeometry), shell);
	await panel.evaluate(`document.querySelector("agent-interface .overflow-y-auto").scrollTop = 0`);
	await sleep(100);
	assert.deepEqual(await panel.evaluate(finalGeometry), shell);
	assert.deepEqual(await panel.evaluate(offScale), []);
	const type = (selector) =>
		panel.evaluate(`(() => {
			const style = getComputedStyle(document.querySelector(${JSON.stringify(selector)}));
			return [style.fontSize, style.lineHeight];
		})()`);
	assert.deepEqual(await type("assistant-message .markdown-content p"), ["16px", "26px"], "chat");
	assert.deepEqual(await type("message-editor textarea"), ["16px", "24px"], "composer");
	assert.deepEqual(await type("div.h-11 button"), ["14px", "20px"], "header");
});

test("padding and gaps stay on the 4 px scale", async () => {
	await load(400);
	const { panel } = context;
	assert.deepEqual(await panel.evaluate(offScale), [], "welcome");
	await panel.evaluate(`document.querySelector("overflow-menu button").click()`);
	await sleep(100);
	assert.deepEqual(await panel.evaluate(offScale), [], "menu");
	await click(panel, "Settings");
	await panel.waitFor(`document.querySelectorAll("nav button").length > 5`);
	assert.deepEqual(await panel.evaluate(offScale), [], "settings");
	const sections = await panel.evaluate(
		`[...document.querySelectorAll("nav button")].map((b) => b.querySelector("div,span")?.textContent.trim() ?? b.textContent.trim())`,
	);
	for (const section of sections) {
		await click(panel, section, "nav button");
		await sleep(section === "Connectors" ? 800 : 200);
		assert.deepEqual(await panel.evaluate(offScale), [], section);
		await panel.evaluate(`document.querySelector('[aria-label="Back to settings"]').click()`);
		await sleep(50);
	}
});
