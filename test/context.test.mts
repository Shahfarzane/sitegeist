// The view of a chat the model receives: elision steps, tool-call integrity, compaction.
// Run: npm test (node --import tsx --test).

import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { AssistantMessage, Model } from "@mariozechner/pi-ai";
import { ContextManager } from "../src/agent/context-manager.ts";
import { applyCompaction, estimateTokens, findCut, pruneContext, transcript } from "../src/agent/context.ts";
import { backoffMs, classifyFailure } from "../src/agent/recovery.ts";
import { answerOpenToolCalls } from "../src/agent/run-tracker.ts";

const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

function call(i: number): AgentMessage {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id: `c${i}`, name: "extract_image", arguments: {} }],
		api: "openai-completions",
		provider: "fake",
		model: "fake",
		usage,
		stopReason: "toolUse",
		timestamp: i,
	} as AgentMessage;
}

function shot(i: number): AgentMessage {
	return {
		role: "toolResult",
		toolCallId: `c${i}`,
		toolName: "extract_image",
		isError: false,
		content: [{ type: "image", data: `image-${i}`, mimeType: "image/jpeg" }],
		timestamp: i,
	} as AgentMessage;
}

function textResult(i: number, text: string): AgentMessage {
	return { role: "toolResult", toolCallId: `c${i}`, toolName: "repl", isError: false, content: [{ type: "text", text }], timestamp: i } as AgentMessage;
}

function chat(shots: number): AgentMessage[] {
	const messages: AgentMessage[] = [{ role: "user", content: "start", timestamp: 0 }];
	for (let i = 0; i < shots; i++) messages.push(call(i), shot(i));
	return messages;
}

const images = (messages: AgentMessage[]) =>
	messages.flatMap((m) => (m.role === "toolResult" ? m.content.filter((c) => c.type === "image") : []));

test("a short chat comes back untouched", () => {
	const messages = chat(4);
	assert.equal(pruneContext(messages), messages);
});

test("old screenshots go in batches and the newest stay", () => {
	const view = pruneContext(chat(11));
	assert.equal(images(view).length, 5);
	const newest = images(view).at(-1);
	assert.equal(newest?.type === "image" && newest.data, "image-10");
});

test("the view of old messages only changes when a step is crossed", () => {
	const serialized = (n: number) => JSON.stringify(pruneContext(chat(n)).slice(0, 20));
	assert.equal(serialized(10), serialized(15));
	assert.notEqual(serialized(15), serialized(16));
});

test("pruning leaves the stored chat alone", () => {
	const messages = chat(20);
	const before = JSON.stringify(messages);
	pruneContext(messages);
	assert.equal(JSON.stringify(messages), before);
});

test("images the user attached stay", () => {
	const messages: AgentMessage[] = [
		{ role: "user", content: [{ type: "image", data: "mine", mimeType: "image/png" }], timestamp: 0 },
		...chat(30).slice(1),
	];
	const view = pruneContext(messages);
	assert.deepEqual((view[0] as { content: unknown }).content, [{ type: "image", data: "mine", mimeType: "image/png" }]);
});

test("old tool output is shortened and recent output stays whole", () => {
	const messages: AgentMessage[] = [{ role: "user", content: "start", timestamp: 0 }];
	for (let i = 0; i < 30; i++) messages.push(call(i), textResult(i, "x".repeat(5000)));
	const view = pruneContext(messages);
	const lengths = view.filter((m) => m.role === "toolResult").map((m) => (m.content[0] as { text: string }).text.length);
	assert.ok(lengths[0] < 2000);
	assert.equal(lengths.at(-1), 5000);
});

test("a cut never lands on a tool result", () => {
	const messages = chat(30);
	for (const keep of [0, 1, 500, 1600, 1700, 3300, 9000, 20000]) {
		const cut = findCut(messages, keep);
		if (cut !== undefined) assert.notEqual(messages[cut].role, "toolResult", `keep=${keep}`);
	}
});

test("the compacted view starts with the summary and keeps the tail", () => {
	const messages = chat(10);
	const view = applyCompaction(messages, { cut: 11, summary: "did things" });
	assert.equal(view.length, messages.length - 11 + 1);
	assert.ok(JSON.stringify(view[0]).includes("did things"));
	assert.equal(view[1], messages[11]);
});

test("a full chat is summarized once and the summary survives later turns", async () => {
	const messages = chat(200);
	let summaries = 0;
	const saved: unknown[] = [];
	const manager = new ContextManager({
		model: () => ({ contextWindow: 30000 }) as Model<"openai-completions">,
		summarize: async () => {
			summaries++;
			return "the summary";
		},
		onCompaction: (c) => saved.push(c),
	});
	const longText: AgentMessage[] = [...messages];
	for (let i = 0; i < 60; i++) longText.push(call(1000 + i), textResult(1000 + i, "y".repeat(8000)));
	const view = await manager.prepare(longText);
	assert.equal(summaries, 1);
	assert.equal(saved.length, 1);
	assert.ok(JSON.stringify(view[0]).includes("the summary"));
	assert.ok(view.length < longText.length);
	await manager.prepare([...longText, { role: "user", content: "more", timestamp: 1 }]);
	assert.equal(summaries, 1);
});

test("a chat that fits is never summarized", async () => {
	const manager = new ContextManager({
		model: () => ({ contextWindow: 200000 }) as Model<"openai-completions">,
		summarize: async () => assert.fail("must not summarize"),
		onCompaction: () => assert.fail("must not save"),
	});
	const messages = chat(3);
	assert.equal(await manager.prepare(messages), messages);
});

test("a failing summary still sends the chat, more tightly pruned", async () => {
	const manager = new ContextManager({
		model: () => ({ contextWindow: 15000 }) as Model<"openai-completions">,
		summarize: async () => {
			throw new Error("offline");
		},
		onCompaction: () => assert.fail("nothing to save"),
	});
	const view = await manager.prepare(chat(100));
	assert.equal(images(view).length, 1);
});

test("the transcript drops images and cuts long tool output", () => {
	const text = transcript([{ role: "user", content: "go", timestamp: 0 }, call(1), shot(1), textResult(2, "z".repeat(9000))]);
	assert.ok(text.includes("USER: go"));
	assert.ok(text.includes("[image]"));
	assert.ok(!text.includes("image-1"));
	assert.ok(text.length < 3000);
});

function failed(errorMessage: string): AssistantMessage {
	return { role: "assistant", content: [], stopReason: "error", errorMessage, usage, timestamp: 0 } as unknown as AssistantMessage;
}

test("failures are told apart", () => {
	assert.equal(classifyFailure(failed("429 Too Many Requests")), "transient");
	assert.equal(classifyFailure(failed("Overloaded")), "transient");
	assert.equal(classifyFailure(failed("529 overloaded_error")), "transient");
	assert.equal(classifyFailure(failed("Failed to fetch")), "transient");
	assert.equal(classifyFailure(failed("prompt is too long: 213462 tokens > 200000 maximum")), "overflow");
	assert.equal(classifyFailure(failed("The usage limit has been reached")), undefined);
	assert.equal(classifyFailure(failed("401 invalid x-api-key")), undefined);
	assert.equal(classifyFailure(failed("Your credit balance is too low")), undefined);
	assert.equal(classifyFailure({ ...failed("429"), stopReason: "aborted" }), undefined);
});

test("backoff grows and honours a retry hint", () => {
	const none = () => 0;
	assert.equal(backoffMs(1, "", none), 2000);
	assert.equal(backoffMs(2, "", none), 4000);
	assert.equal(backoffMs(3, "429 retry-after: 20", none), 20000);
	assert.equal(backoffMs(10, "", none), 30000);
});

test("open tool calls get a result so the chat can continue", () => {
	const messages: AgentMessage[] = [{ role: "user", content: "go", timestamp: 0 }, call(1), shot(1), call(2)];
	const repaired = answerOpenToolCalls(messages);
	assert.equal(repaired.length, 5);
	const added = repaired[4];
	assert.ok(added.role === "toolResult" && added.toolCallId === "c2" && added.isError);
	assert.equal(answerOpenToolCalls(repaired), repaired);
});

test("a failed turn's tool calls stay unanswered: providers never see that turn", () => {
	const aborted = { ...call(1), stopReason: "aborted" } as AgentMessage;
	const errored = { ...call(2), stopReason: "error" } as AgentMessage;
	const messages: AgentMessage[] = [{ role: "user", content: "go", timestamp: 0 }, aborted, errored];
	assert.equal(answerOpenToolCalls(messages), messages);
});

test("a cut that drifted onto a tool result does not orphan it", () => {
	const messages = chat(5);
	assert.equal(messages[2].role, "toolResult");
	const view = applyCompaction(messages, { cut: 2, summary: "s" });
	assert.equal(view[1].role, "assistant");
});

test("messages with attachments count toward the context", () => {
	const message = {
		role: "user-with-attachments",
		content: "look",
		attachments: [{ id: "1", type: "image", fileName: "a.png", mimeType: "image/png", size: 1, content: "x" }],
		timestamp: 0,
	} as unknown as AgentMessage;
	assert.ok(estimateTokens([message]) >= 1600);
	assert.ok(transcript([message]).includes("USER: look"));
});

test("only the last turn's open calls are answered: earlier gaps are the provider layer's", () => {
	const reply = { ...call(9), content: [{ type: "text", text: "done" }], stopReason: "stop" } as AgentMessage;
	const messages: AgentMessage[] = [{ role: "user", content: "go", timestamp: 0 }, call(1), reply];
	assert.equal(answerOpenToolCalls(messages), messages);
});

test("the current page keeps its skills list when older ones go", () => {
	const nav = (url: string) => ({ role: "navigation", url, title: url, skillsOutput: `skills of ${url}` }) as AgentMessage;
	const messages: AgentMessage[] = [nav("old"), nav("current")];
	for (let i = 0; i < 40; i++) messages.push(call(i), textResult(i, "x"));
	const view = pruneContext(messages) as Array<{ skillsOutput?: string }>;
	assert.equal(view[0].skillsOutput, "");
	assert.equal(view[1].skillsOutput, "skills of current");
});

test("a summary knows what was attached", () => {
	const message = {
		role: "user-with-attachments",
		content: "read this",
		attachments: [{ id: "1", type: "document", fileName: "a.pdf", mimeType: "application/pdf", size: 1, content: "x", extractedText: "the contract" }],
		timestamp: 0,
	} as unknown as AgentMessage;
	const text = transcript([message]);
	assert.ok(text.includes("a.pdf") && text.includes("the contract"));
});
