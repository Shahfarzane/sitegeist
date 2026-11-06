import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { harnessModels } from "./harness-models.ts";

const saved = { claude: process.env.CLAUDE_CONFIG_DIR, codex: process.env.CODEX_HOME };
let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "harness-models-"));
	process.env.CLAUDE_CONFIG_DIR = dir;
	process.env.CODEX_HOME = dir;
});

afterEach(() => {
	process.env.CLAUDE_CONFIG_DIR = saved.claude;
	process.env.CODEX_HOME = saved.codex;
	if (saved.claude === undefined) delete process.env.CLAUDE_CONFIG_DIR;
	if (saved.codex === undefined) delete process.env.CODEX_HOME;
});

test("reads each CLI's default model", () => {
	writeFileSync(join(dir, "settings.json"), JSON.stringify({ model: "opus[1m]", theme: "dark" }));
	writeFileSync(join(dir, "config.toml"), 'approval_policy = "never"\nmodel = "gpt-6"\n\n[profiles.fast]\nmodel = "gpt-5"\n');
	assert.deepEqual(harnessModels(), { anthropic: "opus[1m]", "openai-codex": "gpt-6" });
});

test("a model set only inside a Codex table is not the default", () => {
	writeFileSync(join(dir, "config.toml"), '[profiles.fast]\nmodel = "gpt-5"\n');
	assert.equal(harnessModels()["openai-codex"], undefined);
});

test("no settings means no opinion", () => {
	assert.deepEqual(harnessModels(), { anthropic: undefined, "openai-codex": undefined });
	writeFileSync(join(dir, "settings.json"), "not json");
	assert.equal(harnessModels().anthropic, undefined);
});
