// What reaches the model from a chat.
// Run: npm test (node --import tsx --test).

import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { browserMessageTransformer } from "../src/messages/message-transformer.ts";

test("a message with attachments reaches the model, words and files", async () => {
	const message = {
		role: "user-with-attachments",
		content: "what is in this area?",
		attachments: [
			{ id: "1", type: "image", fileName: "region.png", mimeType: "image/png", size: 1, content: "AAAA" },
			{ id: "2", type: "document", fileName: "a.pdf", mimeType: "application/pdf", size: 1, content: "x", extractedText: "the text" },
		],
		timestamp: 5,
	} as unknown as AgentMessage;
	const [converted] = await browserMessageTransformer([message]);
	assert.equal(converted.role, "user");
	assert.deepEqual(converted.content, [
		{ type: "text", text: "what is in this area?" },
		{ type: "image", data: "AAAA", mimeType: "image/png" },
		{ type: "text", text: "\n\n[Document: a.pdf]\nthe text" },
	]);
});

test("a file with no extracted text is still named", async () => {
	const message = {
		role: "user-with-attachments",
		content: "",
		attachments: [{ id: "1", type: "document", fileName: "empty.txt", mimeType: "text/plain", size: 0, content: "" }],
		timestamp: 5,
	} as unknown as AgentMessage;
	const [converted] = await browserMessageTransformer([message]);
	assert.deepEqual(converted.content, [{ type: "text", text: "[Attached file: empty.txt]" }]);
});

test("attachments without words still go through", async () => {
	const message = {
		role: "user-with-attachments",
		content: "",
		attachments: [{ id: "1", type: "image", fileName: "a.png", mimeType: "image/png", size: 1, content: "BBBB" }],
		timestamp: 5,
	} as unknown as AgentMessage;
	const [converted] = await browserMessageTransformer([message]);
	assert.deepEqual(converted.content, [{ type: "image", data: "BBBB", mimeType: "image/png" }]);
});
