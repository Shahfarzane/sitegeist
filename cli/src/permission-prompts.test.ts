import assert from "node:assert/strict";
import { test } from "node:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { type CallToolResult, createMcpHandler, InMemoryTransport, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { type Decision, PermissionPrompts, type Track } from "./permission-prompts.ts";

/** Stands in for the extension: a navigation that waits for permission.respond, like askPermission. */
/** `withCallId: false` stands in for an extension from before permission_request named its request. */
function fakeBridge({ withCallId = true } = {}) {
	let seq = 0;
	const waiting = new Map<string, (decision: Decision) => void>();
	const responded: Array<[string, Decision]> = [];
	const denied: string[] = [];
	const prompts = new PermissionPrompts(
		async (requestId, decision) => {
			responded.push([requestId, decision]);
			const resolve = waiting.get(requestId);
			waiting.delete(requestId);
			resolve?.(decision);
		},
		(host) => denied.push(host),
	);
	async function navigate(track: Track, host: string): Promise<CallToolResult> {
		const callId = ++seq;
		track(callId);
		const requestId = `req-${callId}`;
		const decision = new Promise<Decision>((resolve) => waiting.set(requestId, resolve));
		// The event arrives after the request went out, as it does over the socket.
		setTimeout(() => prompts.raise({ requestId, host, ...(withCallId ? { callId } : {}) }), 5);
		const answer = await decision;
		if (answer === "deny") return { content: [{ type: "text", text: `Not allowed to open ${host}` }], isError: true };
		return { content: [{ type: "text", text: `opened ${host} (${answer})` }] };
	}
	let release = () => {};
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});
	function buildServer(): McpServer {
		const server = new McpServer({ name: "test", version: "1.0.0" }, { requestState: { verify: prompts.codec.verify } });
		server.registerTool("navigate", { inputSchema: z.object({ host: z.string() }) }, ({ host }, ctx) =>
			prompts.handle(ctx, server.server.getClientCapabilities(), (track) => navigate(track, host)),
		);
		server.registerTool("plain", { inputSchema: z.object({}) }, (_args, ctx) =>
			prompts.handle(ctx, server.server.getClientCapabilities(), async () => ({ content: [{ type: "text", text: "done" }] })),
		);
		server.registerTool("hold", { inputSchema: z.object({}) }, (_args, ctx) =>
			prompts.handle(ctx, server.server.getClientCapabilities(), async (track) => {
				track(500);
				await held;
				return { content: [{ type: "text", text: "held" }] };
			}),
		);
		return server;
	}
	return { prompts, responded, denied, buildServer, release: () => release() };
}

function makeClient(answer?: { action: "accept" | "decline" | "cancel"; decision?: Decision }, pin2026 = false): {
	client: Client;
	asked: string[];
} {
	const asked: string[] = [];
	const client = new Client(
		{ name: "test-client", version: "1.0.0" },
		{
			...(answer ? { capabilities: { elicitation: { form: {} } } } : {}),
			...(pin2026 ? { versionNegotiation: { mode: { pin: "2026-07-28" } } } : {}),
		},
	);
	if (answer) {
		client.setRequestHandler("elicitation/create", async (request) => {
			asked.push(request.params.message);
			return answer.action === "accept"
				? { action: "accept", content: { decision: answer.decision ?? "allow_once" } }
				: { action: answer.action };
		});
	}
	return { client, asked };
}

async function legacy(bridge: ReturnType<typeof fakeBridge>, client: Client): Promise<void> {
	const [clientEnd, serverEnd] = InMemoryTransport.createLinkedPair();
	await bridge.buildServer().connect(serverEnd);
	await client.connect(clientEnd);
	assert.equal(client.getProtocolEra(), "legacy");
}

async function modern(bridge: ReturnType<typeof fakeBridge>, client: Client): Promise<void> {
	const handler = createMcpHandler(() => bridge.buildServer());
	await client.connect(
		new StreamableHTTPClientTransport(new URL("http://test.local/mcp"), {
			fetch: (url, init) => handler.fetch(new Request(url, init)),
		}),
	);
	assert.equal(client.getProtocolEra(), "modern");
}

function textOf(result: unknown): string {
	const content = (result as CallToolResult).content;
	return content.map((c) => (c.type === "text" ? c.text : "")).join("");
}

for (const [era, connect] of [
	["2025", legacy],
	["2026", modern],
] as const) {
	test(`${era}: the user is asked, and allowing the host finishes the navigation`, async () => {
		const bridge = fakeBridge();
		const { client, asked } = makeClient({ action: "accept", decision: "allow_host" }, era === "2026");
		await connect(bridge, client);
		const result = await client.callTool({ name: "navigate", arguments: { host: "example.com" } });
		assert.equal(textOf(result), "opened example.com (allow_host)");
		assert.deepEqual(asked, ["sitegeist: the browser agent wants to open example.com. Allow?"]);
		assert.deepEqual(bridge.responded, [["req-1", "allow_host"]]);
		await client.close();
	});

	test(`${era}: allow once and deny reach the extension as answered`, async () => {
		for (const decision of ["allow_once", "deny"] as const) {
			const bridge = fakeBridge();
			const { client } = makeClient({ action: "accept", decision }, era === "2026");
			await connect(bridge, client);
			const result = await client.callTool({ name: "navigate", arguments: { host: "example.com" } });
			assert.deepEqual(bridge.responded, [["req-1", decision]]);
			assert.equal(result.isError === true, decision === "deny");
			await client.close();
		}
	});

	test(`${era}: a declined prompt denies`, async () => {
		const bridge = fakeBridge();
		const { client } = makeClient({ action: "decline" }, era === "2026");
		await connect(bridge, client);
		const result = await client.callTool({ name: "navigate", arguments: { host: "example.com" } });
		assert.equal(result.isError, true);
		assert.deepEqual(bridge.responded, [["req-1", "deny"]]);
		await client.close();
	});

	test(`${era}: a client that cannot show forms gets the deny text at once`, async () => {
		const bridge = fakeBridge();
		const { client } = makeClient(undefined, era === "2026");
		await connect(bridge, client);
		const result = await client.callTool({ name: "navigate", arguments: { host: "example.com" } });
		assert.equal(result.isError, true);
		assert.equal(textOf(result), "Not allowed to open example.com");
		assert.deepEqual(bridge.responded, [["req-1", "deny"]]);
		assert.deepEqual(bridge.denied, ["example.com"]);
		await client.close();
	});

	test(`${era}: a call without a question returns as before`, async () => {
		const bridge = fakeBridge();
		const { client } = makeClient({ action: "accept" }, era === "2026");
		await connect(bridge, client);
		assert.equal(textOf(await client.callTool({ name: "plain", arguments: {} })), "done");
		await client.close();
	});
}

test("a question goes to the call whose bridge request raised it", async () => {
	const bridge = fakeBridge();
	const { client, asked } = makeClient({ action: "accept", decision: "allow_once" });
	await legacy(bridge, client);
	const [a, b] = await Promise.all([
		client.callTool({ name: "navigate", arguments: { host: "a.test" } }),
		client.callTool({ name: "navigate", arguments: { host: "b.test" } }),
	]);
	assert.equal(textOf(a), "opened a.test (allow_once)");
	assert.equal(textOf(b), "opened b.test (allow_once)");
	assert.deepEqual(asked.sort(), [
		"sitegeist: the browser agent wants to open a.test. Allow?",
		"sitegeist: the browser agent wants to open b.test. Allow?",
	]);
	await client.close();
});

test("an extension that names no request: the question goes to the running call", async () => {
	const bridge = fakeBridge({ withCallId: false });
	for (const pin of [false, true]) {
		const { client, asked } = makeClient({ action: "accept", decision: "allow_once" }, pin);
		await (pin ? modern : legacy)(bridge, client);
		const result = await client.callTool({ name: "navigate", arguments: { host: "old.test" } });
		assert.equal(textOf(result), "opened old.test (allow_once)");
		assert.equal(asked.length, 1);
		await client.close();
	}
});

test("a question with no call waiting on it is not taken", () => {
	const bridge = fakeBridge();
	assert.equal(bridge.prompts.raise({ requestId: "r", host: "example.com", callId: 1 }), false);
	assert.equal(bridge.prompts.raise({ requestId: "r", host: "example.com" }), false);
});

test("a question for a call that ended is not given to another running call", async () => {
	const bridge = fakeBridge();
	const { client } = makeClient({ action: "accept" });
	await legacy(bridge, client);
	const running = client.callTool({ name: "hold", arguments: {} });
	await new Promise((resolve) => setTimeout(resolve, 20));
	assert.equal(bridge.prompts.raise({ requestId: "r", host: "example.com", callId: 99 }), false);
	bridge.release();
	assert.equal(textOf(await running), "held");
	await client.close();
});
