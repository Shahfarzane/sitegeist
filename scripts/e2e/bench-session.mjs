/**
 * Measures what one streamed reply costs the panel: IndexedDB writes, main-thread time, long
 * tasks and first-render time, on a chat that already holds SHOTS screenshots.
 *
 *   SITEGEIST_VERSION=9.9.9 node scripts/build.mjs && node scripts/e2e/bench-session.mjs
 */

import {
	Browser,
	composerReady,
	EXTENSION_ID,
	idbPutSource,
	seedProvider,
	sendPrompt,
	startFakeServer,
} from "./lib.mjs";

const SHOTS = Number(process.env.SHOTS ?? 40);
const SHOT_BYTES = Number(process.env.SHOT_BYTES ?? 200_000);
const TOKENS = Number(process.env.TOKENS ?? 1500);

const instrument = `
(() => {
	const stats = { puts: {}, putMs: 0, longTasks: 0, longTaskMs: 0, composerAt: 0 };
	window.__stats = stats;
	const put = IDBObjectStore.prototype.put;
	IDBObjectStore.prototype.put = function (...args) {
		const t = performance.now();
		const r = put.apply(this, args);
		stats.putMs += performance.now() - t;
		stats.puts[this.name] = (stats.puts[this.name] ?? 0) + 1;
		return r;
	};
	new PerformanceObserver((list) => {
		for (const e of list.getEntries()) { stats.longTasks++; stats.longTaskMs += e.duration; }
	}).observe({ entryTypes: ["longtask"] });
	const tick = () => {
		if (document.querySelector("message-editor textarea")) stats.composerAt = performance.now();
		else requestAnimationFrame(tick);
	};
	requestAnimationFrame(tick);
})();`;

const server = await startFakeServer({
	routes: { "/page": "<!doctype html><title>Bench page</title><h1>Bench page</h1>" },
	script: () => ({
		tokens: Array.from({ length: TOKENS }, (_, i) => `word${i} `),
		delayMs: 2,
	}),
});
const browser = await Browser.launch();
try {
	const worker = await browser.worker();
	const tab = await browser.open(`${server.origin}/page`);
	await tab.waitFor(`document.title === "Bench page"`);
	const tabId = await worker.evaluate(
		`chrome.tabs.query({}).then((ts) => ts.find((t) => (t.url || "").endsWith("/page")).id)`,
	);

	const panelUrl = `chrome-extension://${EXTENSION_ID}/sidepanel.html?tabId=${tabId}`;
	const panel = await browser.open(panelUrl, { init: instrument });
	await composerReady(panel);
	const model = await seedProvider(panel, server.baseUrl);

	// A chat as it looks after SHOTS screenshot tool calls.
	const sessionId = "bench-session";
	const image = "A".repeat(SHOT_BYTES);
	const usage = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	await panel.evaluate(`${idbPutSource}
		(async () => {
			const image = ${JSON.stringify(image)};
			const usage = ${JSON.stringify(usage)};
			const model = ${JSON.stringify(model)};
			const messages = [{ role: "user", content: "start", timestamp: 1 }];
			for (let i = 0; i < ${SHOTS}; i++) {
				messages.push({ role: "assistant", content: [{ type: "toolCall", id: "c" + i, name: "extract_image", arguments: {} }],
					api: model.api, provider: "fake", model: model.id, usage, stopReason: "toolUse", timestamp: 2 });
				messages.push({ role: "toolResult", toolCallId: "c" + i, toolName: "extract_image", isError: false,
					content: [{ type: "image", data: image, mimeType: "image/jpeg" }], timestamp: 3 });
			}
			messages.push({ role: "assistant", content: [{ type: "text", text: "done" }], api: model.api, provider: "fake",
				model: model.id, usage, stopReason: "stop", timestamp: 4 });
			const now = new Date().toISOString();
			await window.__idbPut("sessions", ${JSON.stringify(sessionId)}, { id: ${JSON.stringify(sessionId)}, title: "bench", model,
				thinkingLevel: "off", messages, createdAt: now, lastModified: now });
			await window.__idbPut("sessions-metadata", ${JSON.stringify(sessionId)}, { id: ${JSON.stringify(sessionId)}, title: "bench",
				createdAt: now, lastModified: now, messageCount: messages.length, usage, modelId: model.id, thinkingLevel: "off", preview: "" });
		})()`);

	await panel.send("Page.navigate", { url: `${panelUrl}&session=${sessionId}` });
	await composerReady(panel);
	await panel.waitFor(`window.__stats.composerAt > 0`);
	const composerAt = await panel.evaluate(`window.__stats.composerAt`);
	const before = await panel.metrics();
	await panel.evaluate(
		`(() => { const s = window.__stats; s.puts = {}; s.putMs = 0; s.longTasks = 0; s.longTaskMs = 0; })()`,
	);

	const started = Date.now();
	await sendPrompt(panel, "stream something");
	await panel.waitFor(`document.body.innerText.includes("word${TOKENS - 1}")`, { timeoutMs: 180000 });
	const elapsed = Date.now() - started;
	await new Promise((r) => setTimeout(r, 1500));

	const after = await panel.metrics();
	const stats = await panel.evaluate(`window.__stats`);
	console.log(
		JSON.stringify(
			{
				sessionShots: SHOTS,
				sessionMB: Number(((SHOTS * SHOT_BYTES) / 1e6).toFixed(1)),
				tokens: TOKENS,
				composerReadyMs: Math.round(composerAt),
				streamWallMs: elapsed,
				idbPuts: stats.puts,
				idbPutSyncMs: Math.round(stats.putMs),
				longTasks: stats.longTasks,
				longTaskMs: Math.round(stats.longTaskMs),
				mainThreadTaskMs: Math.round((after.TaskDuration - before.TaskDuration) * 1000),
				scriptMs: Math.round((after.ScriptDuration - before.ScriptDuration) * 1000),
				jsHeapMB: Math.round(after.JSHeapUsedSize / 1e6),
			},
			null,
			2,
		),
	);
} finally {
	await browser.close();
	await server.close();
}
