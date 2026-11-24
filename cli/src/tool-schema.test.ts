import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { pruneSchema, toolInput } from "./tool-schema.ts";

test("pruning drops the draft URL and safe-integer bounds, and keeps real bounds", () => {
	const schema = toolInput({
		tabId: z.number().int().optional().describe("Default: your current tab"),
		limit: z.number().int().min(1).max(100).optional(),
		options: z.object({ width: z.number().int().optional() }).optional(),
	})["~standard"].jsonSchema.input({ target: "draft-2020-12" });
	assert.deepEqual(schema, {
		type: "object",
		properties: {
			tabId: { description: "Default: your current tab", type: "integer" },
			limit: { type: "integer", minimum: 1, maximum: 100 },
			options: { type: "object", properties: { width: { type: "integer" } } },
		},
	});
});

test("pruning leaves a parameter that is merely named like a keyword", () => {
	const schema = {
		$schema: "https://json-schema.org/draft/2020-12/schema",
		type: "object",
		properties: { minimum: { type: "number" }, $schema: { type: "string" } },
	};
	assert.deepEqual(pruneSchema(schema), { type: "object", properties: { minimum: { type: "number" }, $schema: { type: "string" } } });
});

test("a pruned schema still validates arguments", async () => {
	const input = toolInput({ tabId: z.number().int().optional() });
	assert.deepEqual(await input["~standard"].validate({ tabId: 3 }), { value: { tabId: 3 } });
	assert.ok((await input["~standard"].validate({ tabId: 1.5 })).issues);
});

interface ListedTool {
	name: string;
	description?: string;
	inputSchema: unknown;
}

/** `sitegeist mcp` as a harness sees it: the instructions and the tool list, with no browser behind it. */
async function listTools(): Promise<{ instructions: string; tools: ListedTool[] }> {
	const home = mkdtempSync(join(tmpdir(), "sitegeist-tools-"));
	const child = spawn(process.execPath, ["--import", "tsx", "--no-warnings", fileURLToPath(new URL("./index.ts", import.meta.url)), "mcp"], {
		env: { ...process.env, HOME: home, SITEGEIST_SOCKET_DIR: join(home, "sockets") },
		stdio: ["pipe", "pipe", "ignore"],
	});
	try {
		const replies = new Map<number, (result: Record<string, unknown>) => void>();
		let buffer = "";
		child.stdout.on("data", (chunk: Buffer) => {
			buffer += chunk;
			for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
				const line = buffer.slice(0, end).trim();
				buffer = buffer.slice(end + 1);
				if (!line) continue;
				const message = JSON.parse(line) as { id?: number; result?: Record<string, unknown> };
				if (message.id !== undefined && message.result) replies.get(message.id)?.(message.result);
			}
		});
		const send = (message: Record<string, unknown>) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
		const request = (id: number, method: string, params: Record<string, unknown>) =>
			new Promise<Record<string, unknown>>((resolve) => {
				replies.set(id, resolve);
				send({ id, method, params });
			});
		const init = await request(1, "initialize", {
			protocolVersion: "2025-06-18",
			capabilities: {},
			clientInfo: { name: "test", version: "0" },
		});
		send({ method: "notifications/initialized" });
		const list = await request(2, "tools/list", {});
		return { instructions: String(init.instructions), tools: list.tools as ListedTool[] };
	} finally {
		child.kill();
		rmSync(home, { recursive: true, force: true });
	}
}

/**
 * Every harness pays for the tool list on each run, and most pay for it on every turn.
 * It was 25,041 characters before the schemas were pruned; the budgets leave room for a
 * tool or two, not for the boilerplate to come back.
 */
test("the tool list stays within its budget and carries no schema boilerplate", { timeout: 30000 }, async () => {
	const { instructions, tools } = await listTools();
	const listed = JSON.stringify(tools);
	assert.ok(listed.length <= 19500, `tools/list is ${listed.length} characters`);
	assert.ok(instructions.length <= 1200, `instructions are ${instructions.length} characters`);
	assert.ok(!listed.includes("$schema"), "a schema still names its draft");
	assert.ok(!listed.includes(String(Number.MAX_SAFE_INTEGER)), "an integer still carries safe-integer bounds");
	for (const tool of tools) {
		// Claude Code cuts a description at 4,096 characters when a tool loads up front.
		assert.ok((tool.description ?? "").length <= 700, `${tool.name}: description is ${tool.description?.length} characters`);
	}
});
