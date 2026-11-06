/**
 * The model each coding CLI is set to, so new chats can open on the same one. Only that setting
 * is read: `model` in Claude Code's settings.json, top-level `model` in Codex's config.toml.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { HarnessModels } from "../../src/bridge/protocol.ts";

function claudeCodeModel(): string | undefined {
	try {
		const dir = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
		const { model } = JSON.parse(readFileSync(join(dir, "settings.json"), "utf8")) as { model?: unknown };
		return typeof model === "string" && model ? model : undefined;
	} catch {
		return undefined;
	}
}

function codexModel(): string | undefined {
	try {
		const dir = process.env.CODEX_HOME || join(homedir(), ".codex");
		for (const line of readFileSync(join(dir, "config.toml"), "utf8").split("\n")) {
			// A `model` under a [table] belongs to a profile or provider, not the default.
			if (line.trimStart().startsWith("[")) return undefined;
			const match = /^\s*model\s*=\s*["']([^"']+)["']/.exec(line);
			if (match) return match[1];
		}
	} catch {
		/* no Codex here */
	}
	return undefined;
}

export function harnessModels(): HarnessModels {
	return { anthropic: claudeCodeModel(), "openai-codex": codexModel() };
}
