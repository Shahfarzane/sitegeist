// A minimal MCP server over stdio, for the local connector test.
import { createInterface } from "node:readline";

const write = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
createInterface({ input: process.stdin }).on("line", (line) => {
	const { id, method, params } = JSON.parse(line);
	if (id === undefined) return;
	if (method === "initialize") {
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
				],
			},
		});
	} else if (method === "tools/call") {
		const text = params.name === "big" ? "z".repeat(2_000_000) : `local says ${params.arguments.text}`;
		write({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text }] } });
	} else write({ jsonrpc: "2.0", id, error: { code: -32601, message: "no" } });
});
