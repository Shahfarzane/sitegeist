// A minimal MCP server over stdio that predates the 2026-07-28 revision, for the local connector test.
// argv[2], when given, is a file that gets "start" once per process and a line per request.
// argv[3] "strict" makes it exit on any request before initialize, as servers on the Rust SDK do.
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const [log, mode] = process.argv.slice(2);
const note = (line) => {
	if (log) appendFileSync(log, `${line}\n`);
};
note("start");
let initialized = false;

const write = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
createInterface({ input: process.stdin }).on("line", (line) => {
	const { id, method, params } = JSON.parse(line);
	if (id === undefined) return;
	note(method);
	if (mode === "strict" && !initialized && method !== "initialize") process.exit(1);
	if (method === "initialize") {
		initialized = true;
		write({
			jsonrpc: "2.0",
			id,
			result: {
				protocolVersion: params.protocolVersion,
				capabilities: { tools: {} },
				serverInfo: { name: "fake-local", version: "1.0.0" },
			},
		});
	} else if (method === "tools/list") {
		write({
			jsonrpc: "2.0",
			id,
			result: {
				tools: [
					{
						name: "echo",
						description: "Echo text",
						inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
					},
					{ name: "big", description: "A large result", inputSchema: { type: "object", properties: {} } },
					{
						name: "wide",
						description: "A large result in three-byte characters",
						inputSchema: { type: "object", properties: {} },
					},
				],
			},
		});
	} else if (method === "tools/call") {
		const text =
			params.name === "big"
				? "z".repeat(2_000_000)
				: params.name === "wide"
					? "語".repeat(700_000)
					: `local says ${params.arguments.text}`;
		write({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text }] } });
	} else write({ jsonrpc: "2.0", id, error: { code: -32601, message: "no" } });
});
