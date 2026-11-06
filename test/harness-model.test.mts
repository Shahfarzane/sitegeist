// New chats follow the model the user's coding CLI is set to.
// Run: npm test (node --import tsx --test).

import assert from "node:assert/strict";
import { test } from "node:test";
import type { Model } from "@mariozechner/pi-ai";
import { resolveHarnessModel } from "../src/models/harness-default.ts";

const models = [
	"claude-3-opus-20240229",
	"claude-haiku-4-5",
	"claude-opus-4-1",
	"claude-opus-4-20250514",
	"claude-opus-4-5-20251101",
	"claude-opus-4-6",
	"claude-opus-5-5",
	"claude-opus-5-5-20261001",
	"claude-sonnet-4-6",
	"claude-sonnet-5-5",
].map((id) => ({ id }) as Model<any>);

const resolve = (setting: string) => resolveHarnessModel(setting, models)?.id;

test("an alias means the newest of its family", () => {
	assert.equal(resolve("opus"), "claude-opus-5-5");
	assert.equal(resolve("sonnet"), "claude-sonnet-5-5");
	assert.equal(resolve("haiku"), "claude-haiku-4-5");
});

test("a context suffix does not change the model", () => {
	assert.equal(resolve("opus[1m]"), "claude-opus-5-5");
	assert.equal(resolve("claude-sonnet-4-6[1m]"), "claude-sonnet-4-6");
});

test("Claude Code's other aliases", () => {
	assert.equal(resolve("best"), "claude-opus-5-5");
	assert.equal(resolve("opusplan"), "claude-opus-5-5");
});

test("an exact id wins", () => {
	assert.equal(resolve("claude-opus-4-1"), "claude-opus-4-1");
});

test("what cannot be matched resolves to nothing", () => {
	assert.equal(resolve("default"), undefined);
	assert.equal(resolve("gpt-6.1-sol"), undefined);
	assert.equal(resolveHarnessModel("opus", []), undefined);
});
