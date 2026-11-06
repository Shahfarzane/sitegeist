/**
 * Installs a plugin folder in the Claude plugin layout: skills/<name>/SKILL.md become skills for
 * any site, commands/<name>.md saved prompts, .mcp.json remote servers connectors. Local servers
 * in a plugin are reported, not installed: a folder from elsewhere must not start programs.
 */

import { ANY_SITE } from "../storage/skill-match.js";
import type { Connector } from "../storage/stores/connectors-store.js";
import type { SavedPrompt } from "../storage/stores/prompts-store.js";
import type { Skill } from "../storage/stores/skills-store.js";

export interface PluginFile {
	/** Path inside the plugin folder, with / separators. */
	path: string;
	text: string;
}

export interface Plugin {
	name: string;
	skills: Skill[];
	prompts: SavedPrompt[];
	connectors: Connector[];
	/** Local servers the user must add themselves with `sitegeist connectors add`. */
	skippedLocalServers: string[];
}

interface Frontmatter {
	fields: Record<string, string>;
	body: string;
}

function parseFrontmatter(text: string): Frontmatter {
	const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
	if (!match) return { fields: {}, body: text };
	const fields: Record<string, string> = {};
	for (const line of match[1].split(/\r?\n/)) {
		const field = /^([A-Za-z_-]+):\s*(.*)$/.exec(line);
		if (field) fields[field[1].toLowerCase()] = field[2].replace(/^["']|["']$/g, "").trim();
	}
	return { fields, body: match[2].trim() };
}

function firstLine(text: string): string {
	return (
		text
			.split("\n")
			.find((line) => line.trim() && !line.startsWith("#"))
			?.trim()
			.slice(0, 140) ?? ""
	);
}

/** Drop the folder the user picked, so paths start at the plugin root. */
function relative(files: PluginFile[]): PluginFile[] {
	const manifest = files.find((f) => /(^|\/)\.claude-plugin\/plugin\.json$/.test(f.path));
	if (manifest) {
		const prefix = manifest.path.replace(/\.claude-plugin\/plugin\.json$/, "");
		return files.filter((f) => f.path.startsWith(prefix)).map((f) => ({ ...f, path: f.path.slice(prefix.length) }));
	}
	const first = files[0]?.path.split("/")[0];
	const isPluginFolder = first === "skills" || first === "commands";
	if (first && !isPluginFolder && files.every((f) => f.path.startsWith(`${first}/`))) {
		return files.map((f) => ({ ...f, path: f.path.slice(first.length + 1) }));
	}
	return files;
}

export function parsePlugin(input: PluginFile[]): Plugin {
	const files = relative(input);
	const now = new Date().toISOString();
	const manifest = files.find((f) => f.path === ".claude-plugin/plugin.json");
	let name = "plugin";
	if (manifest) name = (JSON.parse(manifest.text) as { name?: string }).name ?? name;

	const skills: Skill[] = [];
	const prompts: SavedPrompt[] = [];
	for (const file of files) {
		const skill = /^skills\/([^/]+)\/SKILL\.md$/i.exec(file.path);
		if (skill) {
			const { fields, body } = parseFrontmatter(file.text);
			skills.push({
				name: fields.name || skill[1],
				domainPatterns: [ANY_SITE],
				shortDescription: fields.description || firstLine(body),
				description: body,
				createdAt: now,
				lastUpdated: now,
				examples: "",
				library: "",
			});
		}
		const command = /^commands\/(.+)\.md$/i.exec(file.path);
		if (command) {
			const { body } = parseFrontmatter(file.text);
			prompts.push({ name: command[1].replace(/\//g, "-"), text: body, createdAt: now });
		}
	}

	const connectors: Connector[] = [];
	const skippedLocalServers: string[] = [];
	const mcp = files.find((f) => f.path === ".mcp.json");
	if (mcp) {
		const parsed = JSON.parse(mcp.text) as {
			mcpServers?: Record<
				string,
				{ url?: string; type?: string; headers?: Record<string, string>; command?: string }
			>;
		};
		for (const [server, config] of Object.entries(parsed.mcpServers ?? {})) {
			if (config.url) {
				connectors.push({
					name: server,
					kind: "remote",
					url: config.url,
					headers: config.headers,
					enabled: true,
					createdAt: now,
				});
			} else skippedLocalServers.push(server);
		}
	}
	return { name, skills, prompts, connectors, skippedLocalServers };
}

/** Read what the user picked in a folder input. */
export async function readPluginFolder(files: FileList): Promise<PluginFile[]> {
	const wanted = /(\.md|\.json)$/i;
	const picked = Array.from(files).filter((f) => wanted.test(f.name) && f.size < 2_000_000);
	return Promise.all(picked.map(async (f) => ({ path: f.webkitRelativePath || f.name, text: await f.text() })));
}
