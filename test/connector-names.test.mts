// Connector tools reach the provider, which restricts tool names.
// Run: npm test (node --import tsx --test).

import assert from "node:assert/strict";
import { test } from "node:test";
import { connectorToolName, toToolContent } from "../src/connectors/manager.ts";

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
});
