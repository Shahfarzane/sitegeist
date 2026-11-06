// Connectors in a real panel: a remote server with a token, OAuth through the settings UI, a local
// command through the native host, and a result over the 1 MiB native messaging limit.
// Run: SITEGEIST_VERSION=9.9.9 node scripts/build.mjs && (cd cli && npm run build) && npm run test:e2e

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { Browser, bridgeReady, idbPutSource, openPanel, repoRoot, sendPrompt, startFakeServer } from "./lib.mjs";

const page = "<!doctype html><title>Connect</title><h1>Connect</h1>";
const TOOLS = [
	{
		name: "search",
		description: "Search the notes",
		inputSchema: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
	},
];

let browser;
let server;
let turns;
let mcp;
let mcpOrigin;
const seen = { authorization: [] };
const configDir = mkdtempSync(join(tmpdir(), "sitegeist-e2e-config-"));

function jsonRpc(req, res, body) {
	const { id, method, params } = body;
	if (id === undefined) return res.writeHead(202).end();
	let result;
	if (method === "initialize") {
		result = {
			protocolVersion: params.protocolVersion,
			capabilities: { tools: {} },
			serverInfo: { name: "fake-remote", version: "1.0.0" },
		};
	} else if (method === "tools/list") result = { tools: TOOLS };
	else if (method === "tools/call")
		result = { content: [{ type: "text", text: `found ${params.arguments.q} in the notes` }] };
	else result = {};
	res.writeHead(200, { "content-type": "application/json" });
	res.end(JSON.stringify({ jsonrpc: "2.0", id, result }));
}

async function readJson(req) {
	const chunks = [];
	for await (const c of req) chunks.push(c);
	return Buffer.concat(chunks).toString("utf8");
}

function startMcp() {
	return new Promise((resolve) => {
		const http = createServer(async (req, res) => {
			const url = new URL(req.url, "http://127.0.0.1");
			const json = (value) => {
				res.writeHead(200, { "content-type": "application/json" });
				res.end(JSON.stringify(value));
			};
			if (
				url.pathname === "/.well-known/oauth-protected-resource/oauth-mcp" ||
				url.pathname === "/.well-known/oauth-protected-resource"
			) {
				return json({ resource: `${mcpOrigin}/oauth-mcp`, authorization_servers: [mcpOrigin] });
			}
			if (url.pathname === "/.well-known/oauth-authorization-server") {
				return json({
					issuer: mcpOrigin,
					authorization_endpoint: `${mcpOrigin}/authorize`,
					token_endpoint: `${mcpOrigin}/token`,
					registration_endpoint: `${mcpOrigin}/register`,
					response_types_supported: ["code"],
					grant_types_supported: ["authorization_code"],
					code_challenge_methods_supported: ["S256"],
				});
			}
			if (url.pathname === "/register") {
				const body = JSON.parse(await readJson(req));
				return json({ ...body, client_id: "client-1" });
			}
			if (url.pathname === "/authorize") {
				const redirect = new URL(url.searchParams.get("redirect_uri"));
				redirect.searchParams.set("code", "the-code");
				redirect.searchParams.set("state", url.searchParams.get("state") ?? "");
				res.writeHead(302, { location: redirect.toString() });
				return res.end();
			}
			if (url.pathname === "/token") return json({ access_token: "oauth-token", token_type: "Bearer" });
			if (url.pathname === "/mcp" || url.pathname === "/oauth-mcp") {
				if (req.method !== "POST") return res.writeHead(405).end();
				const authorization = req.headers.authorization ?? "";
				seen.authorization.push(authorization);
				const allowed =
					url.pathname === "/mcp"
						? authorization === "Bearer secret-token"
						: authorization === "Bearer oauth-token";
				if (!allowed) {
					res.writeHead(401, {
						"www-authenticate": `Bearer resource_metadata="${mcpOrigin}/.well-known/oauth-protected-resource/oauth-mcp"`,
					});
					return res.end();
				}
				return jsonRpc(req, res, JSON.parse(await readJson(req)));
			}
			res.writeHead(404).end();
		});
		http.listen(0, "127.0.0.1", () => {
			mcpOrigin = `http://127.0.0.1:${http.address().port}`;
			resolve(http);
		});
	});
}

before(async () => {
	mcp = await startMcp();
	server = await startFakeServer({
		routes: { "/c1": page, "/c2": page, "/c3": page, "/c4": page },
		script: (body, index) => turns(body, index),
	});
	execFileSync(
		process.execPath,
		[
			join(repoRoot, "cli/dist/index.js"),
			"connectors",
			"add",
			"fake-local",
			"--",
			process.execPath,
			join(repoRoot, "scripts/e2e/fake-stdio-server.mjs"),
		],
		{ env: { ...process.env, SITEGEIST_CONFIG_DIR: configDir } },
	);
	browser = await Browser.launch({ bridge: true, env: { SITEGEIST_CONFIG_DIR: configDir } });
	await browser.worker();
	await bridgeReady(browser);
});

after(async () => {
	await browser.close();
	await server.close();
	mcp.closeAllConnections();
	mcp.close();
	rmSync(configDir, { recursive: true, force: true });
});

const toolNames = (body) => (body.tools ?? []).map((t) => t.function.name);

function lastToolText(index) {
	const body = server.requests[index];
	const tool = body.messages.filter((m) => m.role === "tool").at(-1);
	return typeof tool.content === "string" ? tool.content : JSON.stringify(tool.content);
}

async function addConnector(panel, connector) {
	await panel.evaluate(`${idbPutSource}
		window.__idbPut("connectors", ${JSON.stringify(connector.name)}, ${JSON.stringify({ kind: "remote", enabled: true, createdAt: "2026-01-01", ...connector })})`);
}

test("a remote connector with a token gives the agent its tools", async () => {
	server.requests.length = 0;
	turns = (_body, index) =>
		index === 0 ? { toolCalls: [{ name: "notes__search", args: { q: "mango" } }] } : { text: "connector used" };
	const context = await openPanel(browser, server, { path: "/c1" });
	await addConnector(context.panel, {
		name: "notes",
		url: `${mcpOrigin}/mcp`,
		headers: { Authorization: "Bearer secret-token" },
	});
	await context.panel.send("Page.reload");
	await context.panel.waitFor(`!!document.querySelector("message-editor textarea")`);
	await sendPrompt(context.panel, "search the notes");
	await context.panel.waitFor(`document.body.innerText.includes("connector used")`, { timeoutMs: 20000 });
	assert.ok(toolNames(server.requests[0]).includes("notes__search"), toolNames(server.requests[0]).join(","));
	assert.ok(lastToolText(1).includes("found mango in the notes"), lastToolText(1).slice(0, 200));
	await context.panel.evaluate(`${idbPutSource}
		new Promise((res) => { const r = indexedDB.open("sitegeist-storage"); r.onsuccess = () => { const tx = r.result.transaction("connectors", "readwrite"); tx.objectStore("connectors").delete("notes"); tx.oncomplete = () => { r.result.close(); res(); }; }; })`);
	await context.panel.close();
	await context.tab.close();
});

test("a local command connector works through the native host, past the 1 MiB limit", async () => {
	server.requests.length = 0;
	turns = (_body, index) => {
		if (index === 0) return { toolCalls: [{ name: "fake-local__echo", args: { text: "ping" } }] };
		if (index === 1) return { toolCalls: [{ name: "fake-local__big", args: {} }] };
		return { text: "local connector used" };
	};
	const context = await openPanel(browser, server, { path: "/c2" });
	await sendPrompt(context.panel, "use the local connector");
	await context.panel.waitFor(`document.body.innerText.includes("local connector used")`, { timeoutMs: 20000 });
	assert.ok(toolNames(server.requests[0]).includes("fake-local__echo"), toolNames(server.requests[0]).join(","));
	assert.ok(lastToolText(1).includes("local says ping"), lastToolText(1).slice(0, 200));
	assert.match(lastToolText(2), /Truncated: the result has 2000000 characters/);
	assert.ok(lastToolText(2).length < 70000, `big result was ${lastToolText(2).length}`);
	await context.panel.close();
	await context.tab.close();
});

test("an OAuth connector logs in from Settings", async () => {
	turns = () => ({ text: "unused" });
	const context = await openPanel(browser, server, { path: "/c3" });
	await addConnector(context.panel, { name: "secure", url: `${mcpOrigin}/oauth-mcp` });
	await context.panel.send("Page.reload");
	await context.panel.waitFor(`!!document.querySelector("message-editor textarea")`);
	await context.panel.evaluate(`document.querySelector("overflow-menu button").click()`);
	await context.panel.waitFor(
		`[...document.querySelectorAll("button,[role=menuitem]")].some((b) => b.textContent.trim() === "Settings")`,
	);
	await context.panel.evaluate(
		`[...document.querySelectorAll("button,[role=menuitem]")].find((b) => b.textContent.trim() === "Settings").click()`,
	);
	await context.panel.waitFor(
		`[...document.querySelectorAll("nav button")].some((b) => b.textContent.includes("Connectors"))`,
	);
	await context.panel.evaluate(
		`[...document.querySelectorAll("nav button")].find((b) => b.textContent.includes("Connectors")).click()`,
	);
	await context.panel.waitFor(`document.body.innerText.includes("Needs login")`, { timeoutMs: 15000 });
	await context.panel.evaluate(
		`[...document.querySelectorAll("connectors-tab button")].find((b) => b.textContent.trim() === "Log in").click()`,
	);
	await context.panel.waitFor(`document.body.innerText.includes("1 tool")`, { timeoutMs: 15000 });
	assert.ok(seen.authorization.includes("Bearer oauth-token"));
	const stored = await context.panel.evaluate(
		`new Promise((res) => { const r = indexedDB.open("sitegeist-storage"); r.onsuccess = () => { const q = r.result.transaction("connectors").objectStore("connectors").get("secure"); q.onsuccess = () => { r.result.close(); res(q.result.auth.tokens.access_token); }; }; })`,
	);
	assert.equal(stored, "oauth-token");
	await context.panel.close();
	await context.tab.close();
});

test("a server that is down blocks nothing", async () => {
	server.requests.length = 0;
	turns = () => ({ text: "still works" });
	const context = await openPanel(browser, server, { path: "/c4" });
	await addConnector(context.panel, { name: "dead", url: "http://127.0.0.1:9/mcp" });
	await context.panel.send("Page.reload");
	await context.panel.waitFor(`!!document.querySelector("message-editor textarea")`);
	await sendPrompt(context.panel, "hello");
	await context.panel.waitFor(`document.body.innerText.includes("still works")`, { timeoutMs: 15000 });
	await context.panel.close();
	await context.tab.close();
});
