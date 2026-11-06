/**
 * End-to-end harness: Chrome for Testing with the built extension in a throwaway profile,
 * a raw CDP client, and a fake OpenAI-compatible model server that streams scripted turns.
 * Nothing here touches a real browser profile, a real provider, or the network.
 */

import { spawn } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const repoRoot = join(here, "../..");
export const EXTENSION_ID = "lnncppjiohlpejgcbdgoihplimdckddn";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findChrome() {
	if (process.env.SITEGEIST_E2E_CHROME) return process.env.SITEGEIST_E2E_CHROME;
	const root = join(homedir(), ".agent-browser/browsers");
	const versions = existsSync(root) ? readdirSync(root).sort().reverse() : [];
	for (const v of versions) {
		const bin = join(root, v, "Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing");
		if (existsSync(bin)) return bin;
	}
	throw new Error("Chrome for Testing not found: run `agent-browser install` or set SITEGEIST_E2E_CHROME");
}

export class Cdp {
	constructor(ws) {
		this.ws = ws;
		this.seq = 0;
		this.pending = new Map();
		this.listeners = new Set();
		ws.addEventListener("message", (e) => {
			const msg = JSON.parse(e.data);
			if (msg.id !== undefined) {
				const p = this.pending.get(msg.id);
				this.pending.delete(msg.id);
				if (msg.error) p?.reject(new Error(`${p.method}: ${msg.error.message}`));
				else p?.resolve(msg.result);
			} else for (const l of this.listeners) l(msg);
		});
	}
	static async connect(url) {
		const ws = new WebSocket(url);
		await new Promise((resolve, reject) => {
			ws.addEventListener("open", resolve, { once: true });
			ws.addEventListener("error", () => reject(new Error(`CDP connect failed: ${url}`)), { once: true });
		});
		return new Cdp(ws);
	}
	send(method, params = {}, sessionId) {
		const id = ++this.seq;
		return new Promise((resolve, reject) => {
			this.pending.set(id, { resolve, reject, method });
			this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
		});
	}
	on(fn) {
		this.listeners.add(fn);
		return () => this.listeners.delete(fn);
	}
}

/** One attached page or worker. `evaluate` awaits promises and returns by value. */
export class Target {
	constructor(browser, sessionId, targetId) {
		this.browser = browser;
		this.sessionId = sessionId;
		this.targetId = targetId;
	}
	send(method, params) {
		return this.browser.cdp.send(method, params, this.sessionId);
	}
	async evaluate(expression, { timeoutMs = 30000 } = {}) {
		// Cleared afterwards: a pending timer keeps the test process alive after the last test.
		let timer;
		const result = await Promise.race([
			this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture: true }),
			new Promise((_, reject) => {
				timer = setTimeout(() => reject(new Error(`evaluate timed out: ${expression.slice(0, 80)}`)), timeoutMs);
			}),
		]).finally(() => clearTimeout(timer));
		if (result.exceptionDetails) {
			throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
		}
		return result.result.value;
	}
	async waitFor(expression, { timeoutMs = 30000, intervalMs = 50 } = {}) {
		const deadline = Date.now() + timeoutMs;
		for (;;) {
			const value = await this.evaluate(expression).catch(() => undefined);
			if (value) return value;
			if (Date.now() > deadline) throw new Error(`waitFor timed out: ${expression.slice(0, 100)}`);
			await sleep(intervalMs);
		}
	}
	async metrics() {
		await this.send("Performance.enable", {}).catch(() => undefined);
		const { metrics } = await this.send("Performance.getMetrics", {});
		return Object.fromEntries(metrics.map((m) => [m.name, m.value]));
	}
	async screenshot() {
		return (await this.send("Page.captureScreenshot", { format: "png" })).data;
	}
	close() {
		return this.browser.cdp.send("Target.closeTarget", { targetId: this.targetId }).catch(() => undefined);
	}
}

export class Browser {
	/** `bridge`: install the freshly built CLI as this profile's native host, on private sockets. */
	static async launch({
		extensionDir = process.env.SITEGEIST_E2E_EXTENSION ?? join(repoRoot, "dist-chrome"),
		userDataDir,
		headless = true,
		env,
		bridge = false,
		sharedSocketDir,
		hostCli = join(repoRoot, "cli/dist/index.js"),
	} = {}) {
		const profile = userDataDir ?? mkdtempSync(join(tmpdir(), "sitegeist-e2e-"));
		let socketDir;
		if (bridge) {
			socketDir = sharedSocketDir ?? mkdtempSync("/tmp/sg-e2e-");
			chmodSync(socketDir, 0o700);
			const launcher = join(profile, "host.sh");
			writeFileSync(launcher, `#!/bin/sh\nexec "${process.execPath}" "${hostCli}" host "$@"\n`, { mode: 0o755 });
			const hosts = join(profile, "NativeMessagingHosts");
			mkdirSync(hosts, { recursive: true });
			writeFileSync(
				join(hosts, "ai.sitegeist.bridge.json"),
				JSON.stringify({
					name: "ai.sitegeist.bridge",
					description: "sitegeist e2e",
					path: launcher,
					type: "stdio",
					allowed_origins: [`chrome-extension://${EXTENSION_ID}/`],
				}),
			);
		}
		const args = [
			`--user-data-dir=${profile}`,
			"--remote-debugging-port=0",
			"--no-first-run",
			"--no-default-browser-check",
			"--disable-background-networking",
			"--disable-sync",
			"--disable-features=DisableLoadExtensionCommandLineSwitch",
			`--disable-extensions-except=${extensionDir}`,
			`--load-extension=${extensionDir}`,
			"--window-size=1400,950",
			...(headless ? ["--headless=new"] : []),
			"about:blank",
		];
		// A profile used before still holds the last run's port.
		rmSync(join(profile, "DevToolsActivePort"), { force: true });
		const proc = spawn(findChrome(), args, {
			stdio: "ignore",
			env: { ...process.env, ...env, ...(socketDir ? { SITEGEIST_SOCKET_DIR: socketDir } : {}) },
		});
		const portFile = join(profile, "DevToolsActivePort");
		const deadline = Date.now() + 20000;
		while (!existsSync(portFile)) {
			if (Date.now() > deadline) throw new Error("Chrome did not start");
			await sleep(50);
		}
		await sleep(100);
		const [port, path] = readFileSync(portFile, "utf8").trim().split("\n");
		const browser = new Browser();
		browser.proc = proc;
		browser.profile = profile;
		browser.ownsProfile = !userDataDir;
		browser.socketDir = socketDir;
		browser.ownsSockets = !sharedSocketDir;
		browser.cdp = await Cdp.connect(`ws://127.0.0.1:${port}${path}`);
		await browser.cdp.send("Target.setDiscoverTargets", { discover: true });
		return browser;
	}

	async attach(targetId) {
		const { sessionId } = await this.cdp.send("Target.attachToTarget", { targetId, flatten: true });
		return new Target(this, sessionId, targetId);
	}

	async targets() {
		return (await this.cdp.send("Target.getTargets")).targetInfos;
	}

	async worker({ timeoutMs = 15000 } = {}) {
		const deadline = Date.now() + timeoutMs;
		for (;;) {
			const found = (await this.targets()).find(
				(t) => t.type === "service_worker" && t.url.startsWith(`chrome-extension://${EXTENSION_ID}/`),
			);
			if (found) return this.attach(found.targetId);
			if (Date.now() > deadline) throw new Error("Extension service worker did not start");
			await sleep(100);
		}
	}

	/** Open a page; `init` runs before any page script on every document of the tab. */
	async open(url, { init } = {}) {
		const { targetId } = await this.cdp.send("Target.createTarget", { url: "about:blank" });
		const page = await this.attach(targetId);
		await page.send("Page.enable");
		await page.send("Runtime.enable");
		if (init) await page.send("Page.addScriptToEvaluateOnNewDocument", { source: init });
		if (url !== "about:blank") await page.send("Page.navigate", { url });
		return page;
	}

	async close() {
		await Promise.race([this.cdp.send("Browser.close").catch(() => undefined), sleep(1000)]);
		this.proc.kill("SIGKILL");
		this.cdp.ws.close();
		if (this.ownsProfile) rmSync(this.profile, { recursive: true, force: true });
		if (this.socketDir && this.ownsSockets) rmSync(this.socketDir, { recursive: true, force: true });
	}
}

/** Runs in an extension page: open the storage database and put one record. */
export const idbPutSource = `
window.__idbPut = async (store, key, value) => {
	const db = await new Promise((res, rej) => {
		const r = indexedDB.open("sitegeist-storage");
		r.onsuccess = () => res(r.result);
		r.onerror = () => rej(r.error);
	});
	await new Promise((res, rej) => {
		const tx = db.transaction(store, "readwrite");
		const s = tx.objectStore(store);
		if (s.keyPath) s.put(value); else s.put(value, key);
		tx.oncomplete = res;
		tx.onerror = () => rej(tx.error);
	});
	db.close();
};`;

export function fakeModelDefinition(baseUrl, overrides = {}) {
	return {
		id: "fake-model",
		name: "Fake model",
		api: "openai-completions",
		provider: "fake",
		baseUrl,
		reasoning: false,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens: 4096,
		...overrides,
	};
}

/** Point a fresh profile at the fake model: key, custom provider, last used model. */
export async function seedProvider(page, baseUrl, overrides) {
	const model = fakeModelDefinition(baseUrl, overrides);
	await page.evaluate(`${idbPutSource}
		(async () => {
			const model = ${JSON.stringify(model)};
			await window.__idbPut("provider-keys", "fake", "test-key");
			await window.__idbPut("custom-providers", "fake-id", {
				id: "fake-id", name: "fake", type: "openai-completions", baseUrl: ${JSON.stringify(baseUrl)},
				apiKey: "test-key", models: [model],
			});
			await window.__idbPut("settings", "lastUsedModel", model);
		})()`);
	return model;
}

/**
 * Fake chat completions server. `script(requestBody, turnIndex)` returns one turn:
 * { text, tokens, delayMs, toolCalls: [{ name, args }] }. `routes` serves fixture pages.
 */
export async function startFakeServer({ script, routes = {} } = {}) {
	const requests = [];
	const server = createServer(async (req, res) => {
		res.setHeader("Access-Control-Allow-Origin", "*");
		res.setHeader("Access-Control-Allow-Headers", "*");
		if (req.method === "OPTIONS") return res.writeHead(204).end();
		const url = new URL(req.url, "http://127.0.0.1");
		if (url.pathname.endsWith("/chat/completions")) {
			const chunks = [];
			for await (const c of req) chunks.push(c);
			const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
			requests.push(body);
			const turn = await script(body, requests.length - 1);
			if (turn.error) {
				res.writeHead(turn.status ?? 500, { "content-type": "application/json" });
				return res.end(JSON.stringify({ error: { message: turn.error } }));
			}
			res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
			const write = (delta, finish = null) =>
				res.write(
					`data: ${JSON.stringify({
						id: "chatcmpl-fake",
						object: "chat.completion.chunk",
						created: 0,
						model: "fake-model",
						choices: [{ index: 0, delta, finish_reason: finish }],
					})}\n\n`,
				);
			const tokens = turn.tokens ?? (turn.text ? [turn.text] : []);
			for (const token of tokens) {
				write({ role: "assistant", content: token });
				if (turn.delayMs) await sleep(turn.delayMs);
			}
			for (const [index, call] of (turn.toolCalls ?? []).entries()) {
				write({
					tool_calls: [
						{
							index,
							id: `call_${requests.length}_${index}`,
							type: "function",
							function: { name: call.name, arguments: JSON.stringify(call.args ?? {}) },
						},
					],
				});
			}
			write({}, turn.toolCalls?.length ? "tool_calls" : "stop");
			res.write(
				`data: ${JSON.stringify({
					id: "chatcmpl-fake",
					object: "chat.completion.chunk",
					created: 0,
					model: "fake-model",
					choices: [],
					usage: { prompt_tokens: 100, completion_tokens: tokens.length, total_tokens: 100 + tokens.length },
				})}\n\n`,
			);
			res.write("data: [DONE]\n\n");
			return res.end();
		}
		const route = routes[url.pathname];
		if (route !== undefined) {
			const content = typeof route === "function" ? route(req, url) : route;
			res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
			return res.end(content);
		}
		res.writeHead(404).end("not found");
	});
	await new Promise((r) => server.listen(0, "127.0.0.1", r));
	const { port } = server.address();
	return {
		port,
		origin: `http://127.0.0.1:${port}`,
		baseUrl: `http://127.0.0.1:${port}/v1`,
		requests,
		close: () =>
			new Promise((r) => {
				server.close(r);
				server.closeAllConnections();
			}),
	};
}

/** The panel with its composer rendered. */
export function composerReady(page, opts) {
	return page.waitFor(`!!document.querySelector("message-editor textarea")`, opts);
}

/** Type into the composer and send, as a user would. */
export async function sendPrompt(page, text) {
	await page.evaluate(`(() => {
		const ta = document.querySelector("message-editor textarea");
		ta.focus();
		ta.value = ${JSON.stringify(text)};
		ta.dispatchEvent(new Event("input", { bubbles: true }));
	})()`);
	await page.send("Input.dispatchKeyEvent", {
		type: "keyDown",
		key: "Enter",
		code: "Enter",
		windowsVirtualKeyCode: 13,
		text: "\r",
	});
	await page.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
}

/** A tab on the fake server with a side panel document bound to it, on a seeded profile. */
export async function openPanel(browser, server, { path = "/page", model, init, query = "" } = {}) {
	const worker = await browser.worker();
	const tab = await browser.open(`${server.origin}${path}`);
	await tab.waitFor(`document.readyState !== "loading"`);
	const tabId = await worker.evaluate(
		`chrome.tabs.query({}).then((ts) => ts.find((t) => (t.url || "").endsWith(${JSON.stringify(path)})).id)`,
	);
	const url = `chrome-extension://${EXTENSION_ID}/sidepanel.html?tabId=${tabId}`;
	const panel = await browser.open(url, { init });
	await composerReady(panel);
	const seeded = await seedProvider(panel, server.baseUrl, model);
	await panel.send("Page.navigate", { url: `${url}${query}` });
	await composerReady(panel);
	return { panel, tab, worker, tabId, url, model: seeded };
}

/** Store a chat directly, then open it in `panel`. */
export async function seedChat(context, id, messages, title = "seeded") {
	const { panel, url, model } = context;
	const usage = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	const now = new Date().toISOString();
	await panel.evaluate(`${idbPutSource}
		(async () => {
			const id = ${JSON.stringify(id)};
			await window.__idbPut("sessions", id, { id, title: ${JSON.stringify(title)}, model: ${JSON.stringify(model)},
				thinkingLevel: "off", messages: ${JSON.stringify(messages)}, createdAt: ${JSON.stringify(now)}, lastModified: ${JSON.stringify(now)} });
			await window.__idbPut("sessions-metadata", id, { id, title: ${JSON.stringify(title)}, createdAt: ${JSON.stringify(now)},
				lastModified: ${JSON.stringify(now)}, messageCount: ${messages.length}, usage: ${JSON.stringify(usage)},
				modelId: ${JSON.stringify(model.id)}, thinkingLevel: "off", preview: "" });
		})()`);
	await panel.send("Page.navigate", { url: `${url}&session=${id}` });
	await composerReady(panel);
}

export const zeroUsage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

export function assistantToolCall(i, name = "extract_image") {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id: `c${i}`, name, arguments: {} }],
		api: "openai-completions",
		provider: "fake",
		model: "fake-model",
		usage: zeroUsage,
		stopReason: "toolUse",
		timestamp: 2,
	};
}

export function toolResult(i, content, name = "extract_image") {
	return { role: "toolResult", toolCallId: `c${i}`, toolName: name, isError: false, content, timestamp: 3 };
}

export function assistantText(text) {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-completions",
		provider: "fake",
		model: "fake-model",
		usage: zeroUsage,
		stopReason: "stop",
		timestamp: 4,
	};
}

export const pageText = (page) => page.evaluate(`document.body.innerText`);

/** A harness on the real path: MCP client -> `sitegeist mcp` -> socket -> native host -> extension. */
export class Harness {
	static async connect(browser, { name = "e2e", session = "e2e-session", env } = {}) {
		const sdk = join(repoRoot, "cli/node_modules/@modelcontextprotocol/sdk/dist/esm/client");
		const [{ Client }, { StdioClientTransport }] = await Promise.all([
			import(`${sdk}/index.js`),
			import(`${sdk}/stdio.js`),
		]);
		const home = mkdtempSync(join(tmpdir(), "sitegeist-e2e-home-"));
		const transport = new StdioClientTransport({
			command: process.execPath,
			args: [join(repoRoot, "cli/dist/index.js"), "mcp"],
			env: {
				...process.env,
				HOME: home,
				SITEGEIST_SOCKET_DIR: browser.socketDir,
				SITEGEIST_CLIENT_NAME: name,
				SITEGEIST_SESSION: session,
				...env,
			},
			stderr: "ignore",
		});
		const client = new Client({ name: "e2e", version: "1.0.0" });
		await client.connect(transport);
		const harness = new Harness();
		harness.client = client;
		harness.home = home;
		return harness;
	}

	async call(name, args = {}) {
		const result = await this.client.callTool({ name, arguments: args }, undefined, { timeout: 120000 });
		if (result.isError) throw new Error(`${name}: ${result.content.map((c) => c.text).join(" ")}`);
		return result;
	}

	/** The text of a tool result, parsed when it is JSON. */
	async callText(name, args) {
		const result = await this.call(name, args);
		const text = result.content
			.filter((c) => c.type === "text")
			.map((c) => c.text)
			.join("\n");
		try {
			return JSON.parse(text);
		} catch {
			return text;
		}
	}

	async tools() {
		return (await this.client.listTools()).tools.map((t) => t.name);
	}

	async close() {
		await this.client.close();
		rmSync(this.home, { recursive: true, force: true });
	}
}

/** Wait for a bridge host socket to appear in `browser`. */
export async function bridgeReady(browser, timeoutMs = 15000) {
	const deadline = Date.now() + timeoutMs;
	while (readdirSync(browser.socketDir).filter((n) => n.endsWith(".sock")).length === 0) {
		if (Date.now() > deadline) throw new Error("native host did not start");
		await sleep(100);
	}
}
