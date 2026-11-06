// Connector tools reach the provider, which restricts tool names.
// Run: npm test (node --import tsx --test).

import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { ConnectorManager, connectorToolName, toToolContent, uniqueToolNames } from "../src/connectors/manager.ts";

test("tool names stay valid", () => {
	assert.equal(connectorToolName("My Notes!", "search.items"), "My_Notes__search_items");
	assert.match(connectorToolName("n".repeat(80), "t".repeat(80)), /^[a-zA-Z0-9_-]{1,64}$/);
});

test("MCP content maps to tool content", () => {
	assert.deepEqual(
		toToolContent([
			{ type: "text", text: "hi" },
			{ type: "image", data: "AAAA", mimeType: "image/jpeg" },
			{ type: "resource", resource: { uri: "x://y" } },
		]),
		[
			{ type: "text", text: "hi" },
			{ type: "image", data: "AAAA", mimeType: "image/jpeg" },
			{ type: "text", text: '{"uri":"x://y"}' },
		],
	);
	assert.deepEqual(toToolContent([]), [{ type: "text", text: "(no output)" }]);
	const [huge] = toToolContent([{ type: "text", text: "x".repeat(500000) }]);
	assert.ok(huge.type === "text" && huge.text.length < 70000 && huge.text.includes("500000 characters"));
	const many = toToolContent(Array.from({ length: 500 }, () => ({ type: "text", text: "y".repeat(5000) })));
	const total = many.reduce((sum, c) => sum + (c.type === "text" ? c.text.length : 0), 0);
	assert.ok(total < 70000, `${total} characters across blocks`);
	assert.deepEqual(toToolContent([], { rows: 2 }), [{ type: "text", text: '{"rows":2}' }]);
});

test("a refresh replaces tools it issued earlier, whoever triggered it", async () => {
	const manager = new ConnectorManager({ list: async () => [], get: async () => null, save: async () => undefined });
	const issued = { name: "a__b" } as AgentTool<any>;
	const builtIn = { name: "navigate" } as AgentTool<any>;
	assert.equal(manager.owns(builtIn), false);
	manager.adopt(issued);
	assert.equal(manager.owns(issued), true);
});

test("two connectors cannot give the agent the same tool name", () => {
	const tools = [{ name: "a__b" }, { name: "a__b" }, { name: "a__c" }] as AgentTool<any>[];
	assert.deepEqual(
		uniqueToolNames(tools).map((t) => t.name),
		["a__b", "a__c"],
	);
});
