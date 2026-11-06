// Installing a Claude plugin folder, and how connector tools are named.
// Run: npm test (node --import tsx --test).

import assert from "node:assert/strict";
import { test } from "node:test";
import { parsePlugin } from "../src/connectors/plugins.ts";

(globalThis as { chrome?: unknown }).chrome ??= { runtime: { sendNativeMessage: async () => ({ names: [] }) } };

const folder = [
	{ path: "my-plugin/.claude-plugin/plugin.json", text: JSON.stringify({ name: "writer-tools", version: "1.0.0" }) },
	{
		path: "my-plugin/skills/style-guide/SKILL.md",
		text: "---\nname: style-guide\ndescription: Apply the house style to a draft\n---\n\n# Style\n\nShort sentences.\n",
	},
	{ path: "my-plugin/skills/no-front/SKILL.md", text: "# Heading\n\nA skill with no frontmatter." },
	{ path: "my-plugin/commands/review.md", text: "---\ndescription: Review\n---\nReview this page for errors." },
	{ path: "my-plugin/commands/deep/check.md", text: "Check the facts." },
	{
		path: "my-plugin/.mcp.json",
		text: JSON.stringify({
			mcpServers: {
				notes: { type: "http", url: "https://notes.test/mcp", headers: { "X-Team": "a" } },
				files: { command: "npx", args: ["files-server"] },
			},
		}),
	},
	{ path: "my-plugin/README.md", text: "ignored" },
];

test("a plugin folder becomes skills, prompts and connectors", () => {
	const plugin = parsePlugin(folder);
	assert.equal(plugin.name, "writer-tools");
	assert.deepEqual(
		plugin.skills.map((s) => s.name),
		["style-guide", "no-front"],
	);
	const skill = plugin.skills[0];
	assert.deepEqual(skill.domainPatterns, ["*"]);
	assert.equal(skill.shortDescription, "Apply the house style to a draft");
	assert.ok(skill.description.startsWith("# Style"));
	assert.equal(skill.library, "");
	assert.equal(plugin.skills[1].shortDescription, "A skill with no frontmatter.");
	assert.deepEqual(
		plugin.prompts.map((p) => [p.name, p.text]),
		[
			["review", "Review this page for errors."],
			["deep-check", "Check the facts."],
		],
	);
	assert.equal(plugin.connectors.length, 1);
	assert.equal(plugin.connectors[0].url, "https://notes.test/mcp");
	assert.deepEqual(plugin.connectors[0].headers, { "X-Team": "a" });
});

test("a plugin cannot install a local command", () => {
	const plugin = parsePlugin(folder);
	assert.deepEqual(plugin.skippedLocalServers, ["files"]);
	assert.ok(plugin.connectors.every((c) => c.kind === "remote"));
});

test("paths already at the plugin root keep their folders", () => {
	const plugin = parsePlugin([
		{ path: "skills/a/SKILL.md", text: "body" },
		{ path: "skills/b/SKILL.md", text: "body" },
	]);
	assert.deepEqual(
		plugin.skills.map((s) => s.name),
		["a", "b"],
	);
});

test("a folder without a manifest still works", () => {
	const plugin = parsePlugin([{ path: "x/skills/a/SKILL.md", text: "body" }]);
	assert.equal(plugin.name, "plugin");
	assert.equal(plugin.skills.length, 1);
});
