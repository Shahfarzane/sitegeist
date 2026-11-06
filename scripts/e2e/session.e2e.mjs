// A real panel against the fake model: pruning, summaries, retries.
// Run: SITEGEIST_VERSION=9.9.9 node scripts/build.mjs && npm run test:e2e

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import {
	assistantText,
	assistantToolCall,
	Browser,
	openPanel,
	pageText,
	seedChat,
	sendPrompt,
	startFakeServer,
	toolResult,
} from "./lib.mjs";

const page = "<!doctype html><title>Fixture</title><h1>Fixture</h1>";
let browser;
let server;
let turns;

before(async () => {
	server = await startFakeServer({
		routes: { "/page": page, "/page2": page, "/page3": page, "/page4": page },
		script: (body, index) => turns(body, index),
	});
	browser = await Browser.launch();
});

after(async () => {
	await browser.close();
	await server.close();
});

const images = (body) =>
	body.messages.flatMap((m) => (Array.isArray(m.content) ? m.content.filter((c) => c.type === "image_url") : []))
		.length;

test("a long chat sends only recent screenshots", async () => {
	turns = () => ({ text: "looked" });
	const context = await openPanel(browser, server, { path: "/page" });
	const messages = [{ role: "user", content: "start", timestamp: 1 }];
	for (let i = 0; i < 40; i++) {
		messages.push(
			assistantToolCall(i),
			toolResult(i, [{ type: "image", data: "A".repeat(2000), mimeType: "image/jpeg" }]),
		);
	}
	messages.push(assistantText("done"));
	await seedChat(context, "pruned-chat", messages);
	server.requests.length = 0;
	await sendPrompt(context.panel, "what do you see");
	await context.panel.waitFor(`document.body.innerText.includes("looked")`);
	assert.equal(server.requests.length, 1);
	assert.ok(images(server.requests[0]) <= 9, `sent ${images(server.requests[0])} images`);
	await context.panel.close();
	await context.tab.close();
});

test("a rate limited turn retries and finishes on its own", async () => {
	// The provider SDK retries twice by itself; five failures get past it to the panel's retry.
	turns = (_body, index) =>
		index < 5 ? { error: "429 rate limit exceeded", status: 429 } : { text: "recovered reply" };
	server.requests.length = 0;
	const context = await openPanel(browser, server, { path: "/page2" });
	await sendPrompt(context.panel, "hello");
	await context.panel.waitFor(`document.body.innerText.includes("recovered reply")`, { timeoutMs: 30000 });
	const text = await pageText(context.panel);
	assert.ok(!text.includes("rate limit exceeded"), "the failed turn must leave the chat");
	assert.equal(server.requests.length, 6);
	await context.panel.close();
	await context.tab.close();
});

test("a chat that overflows the context is summarized and continues", async () => {
	const summaryText = "SUMMARY-OF-EARLIER-WORK";
	turns = (body, index) => {
		const system = body.messages[0]?.content ?? "";
		if (String(JSON.stringify(system)).includes("You summarize a browser agent")) return { text: summaryText };
		return index === 0
			? { error: "prompt is too long: 213462 tokens > 200000 maximum", status: 400 }
			: { text: "continued after summary" };
	};
	const context = await openPanel(browser, server, { path: "/page3", model: { contextWindow: 40000 } });
	const messages = [{ role: "user", content: "start", timestamp: 1 }];
	for (let i = 0; i < 30; i++) {
		messages.push(assistantToolCall(i, "repl"), toolResult(i, [{ type: "text", text: "x".repeat(3000) }], "repl"));
	}
	messages.push(assistantText("done"));
	await seedChat(context, "overflow-chat", messages);
	server.requests.length = 0;
	await sendPrompt(context.panel, "keep going");
	await context.panel.waitFor(`document.body.innerText.includes("continued after summary")`);
	const last = JSON.stringify(server.requests.at(-1).messages);
	assert.ok(last.includes(summaryText), "the summary must reach the model");
	assert.ok(last.length < JSON.stringify(server.requests[0].messages).length, "the request must shrink");

	// The summary outlives the panel.
	await context.panel.send("Page.reload");
	await context.panel.waitFor(`!!document.querySelector("message-editor textarea")`);
	turns = () => ({ text: "still summarized" });
	server.requests.length = 0;
	await sendPrompt(context.panel, "again");
	await context.panel.waitFor(`document.body.innerText.includes("still summarized")`);
	assert.ok(JSON.stringify(server.requests[0].messages).includes(summaryText));
	await context.panel.close();
	await context.tab.close();
});

test("a chat nearing the limit is summarized before it overflows", async () => {
	let summaries = 0;
	turns = (body) => {
		if (JSON.stringify(body.messages[0]).includes("You summarize a browser agent")) {
			summaries++;
			return { text: "PROACTIVE-SUMMARY" };
		}
		return { text: "proactive reply" };
	};
	const context = await openPanel(browser, server, { path: "/page4", model: { contextWindow: 30000 } });
	const messages = [{ role: "user", content: "start", timestamp: 1 }];
	for (let i = 0; i < 40; i++) {
		messages.push(assistantToolCall(i, "repl"), toolResult(i, [{ type: "text", text: "y".repeat(4000) }], "repl"));
	}
	messages.push(assistantText("done"));
	await seedChat(context, "proactive-chat", messages);
	server.requests.length = 0;
	await sendPrompt(context.panel, "continue");
	await context.panel.waitFor(`document.body.innerText.includes("proactive reply")`);
	assert.equal(summaries, 1);
	assert.ok(JSON.stringify(server.requests.at(-1).messages).includes("PROACTIVE-SUMMARY"));
	await context.panel.close();
	await context.tab.close();
});
