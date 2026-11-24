// A minimal MCP server that speaks only the 2026-07-28 revision over stdio, for the local connector
// test. It refuses initialize, so a client that falls back to the 2025 handshake fails loudly.
// argv[2], when given, is a file that gets "start" once per process and a line per request.
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const REVISION = "2026-07-28";
const VERSION_KEY = "io.modelcontextprotocol/protocolVersion";
const CAPABILITIES_KEY = "io.modelcontextprotocol/clientCapabilities";
const log = process.argv[2];
const note = (line) => {
	if (log) appendFileSync(log, `${line}\n`);
};
note("start");

const write = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const meta = { "io.modelcontextprotocol/serverInfo": { name: "fake-modern", version: "1.0.0" } };
const complete = (id, result) =>
	write({ jsonrpc: "2.0", id, result: { resultType: "complete", ...result, _meta: meta } });
const fail = (id, code, message, data) =>
	write({ jsonrpc: "2.0", id, error: { code, message, ...(data ? { data } : {}) } });
const question = {
	method: "elicitation/create",
	params: {
		mode: "form",
		message: "Go ahead?",
		requestedSchema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
	},
};

const TOOLS = [
	{
		name: "echo",
		description: "Echo text",
		inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
	},
	{ name: "confirm", description: "Asks before it acts", inputSchema: { type: "object", properties: {} } },
	{
		name: "confirm_checked",
		description: "Asks before it acts, if the client can answer",
		inputSchema: { type: "object", properties: {} },
	},
];

createInterface({ input: process.stdin }).on("line", (line) => {
	const { id, method, params } = JSON.parse(line);
	if (id === undefined) return;
	const version = params?._meta?.[VERSION_KEY];
	note(`${method} ${version ?? "-"}`);
	if (method === "server/discover") {
		return complete(id, {
			supportedVersions: [REVISION],
			capabilities: { tools: {} },
			ttlMs: 0,
			cacheScope: "private",
		});
	}
	if (version !== REVISION) {
		const requested = version ?? params?.protocolVersion;
		return fail(id, -32022, `Unsupported protocol version: ${requested}`, { supported: [REVISION], requested });
	}
	if (method === "tools/list") return complete(id, { tools: TOOLS, ttlMs: 0, cacheScope: "private" });
	if (method === "tools/call") {
		if (params.name === "confirm") {
			return write({
				jsonrpc: "2.0",
				id,
				result: { resultType: "input_required", inputRequests: { ok: question } },
			});
		}
		if (params.name === "confirm_checked") {
			// What a server does when the client declared no elicitation: -32021, not a question.
			if (!params._meta?.[CAPABILITIES_KEY]?.elicitation) {
				return fail(id, -32021, "Missing required client capability", {
					requiredCapabilities: { elicitation: {} },
				});
			}
			return write({
				jsonrpc: "2.0",
				id,
				result: { resultType: "input_required", inputRequests: { ok: question } },
			});
		}
		return complete(id, { content: [{ type: "text", text: `modern says ${params.arguments.text}` }] });
	}
	fail(id, -32601, "Method not found");
});
