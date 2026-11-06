/**
 * Local MCP servers for the side panel agent. The commands live in a file only this user writes;
 * the extension can ask for one by name and nothing else, so a page or a model cannot make the
 * host run a program of its choosing.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";

export interface LocalConnector {
	command: string;
	args?: string[];
	env?: Record<string, string>;
	cwd?: string;
}

interface ConnectorFile {
	mcpServers: Record<string, LocalConnector>;
}

/** Native messaging frames top out at 1 MiB, in bytes, after JSON encoding. */
const MAX_WHOLE_BYTES = 800_000;
/** A character is at most 3 bytes once encoded, so a part stays under the limit. */
const MAX_PART_CHARS = 250_000;

export function configDir(): string {
	return process.env.SITEGEIST_CONFIG_DIR ?? join(homedir(), ".config", "sitegeist");
}

function connectorsPath(): string {
	return join(configDir(), "connectors.json");
}

export function readConnectors(): Record<string, LocalConnector> {
	const path = connectorsPath();
	if (!existsSync(path)) return {};
	return (JSON.parse(readFileSync(path, "utf8")) as ConnectorFile).mcpServers ?? {};
}

export function writeConnectors(connectors: Record<string, LocalConnector>): void {
	const path = connectorsPath();
	mkdirSync(dirname(path), { recursive: true });
	const temp = `${path}.tmp`;
	writeFileSync(temp, `${JSON.stringify({ mcpServers: connectors }, null, "\t")}\n`, { mode: 0o600 });
	chmodSync(temp, 0o600);
	renameSync(temp, path);
}

/** Servers from Claude Code's and Claude Desktop's configs that run as commands. */
export function importableConnectors(): Record<string, LocalConnector> {
	const sources = [
		join(homedir(), ".claude.json"),
		join(homedir(), "Library/Application Support/Claude/claude_desktop_config.json"),
	];
	const found: Record<string, LocalConnector> = {};
	for (const source of sources) {
		if (!existsSync(source)) continue;
		try {
			const parsed = JSON.parse(readFileSync(source, "utf8")) as { mcpServers?: Record<string, Partial<LocalConnector>> };
			for (const [name, server] of Object.entries(parsed.mcpServers ?? {})) {
				if (server.command) found[name] = { command: server.command, args: server.args, env: server.env, cwd: server.cwd };
			}
		} catch {
			/* a file being rewritten; skip it */
		}
	}
	return found;
}

export interface RunningConnector {
	write(message: unknown): void;
	stop(): void;
}

export type ConnectorFrame =
	| { type: "connector_message"; message: unknown }
	| { type: "connector_part"; data: string; last: boolean }
	| { type: "connector_closed"; error?: string };

/** Start a configured server and connect its stdio to `send`. */
export function runConnector(name: string, send: (frame: ConnectorFrame) => void): RunningConnector | undefined {
	const config = readConnectors()[name];
	if (!config) {
		send({ type: "connector_closed", error: `No local connector named ${name}` });
		return undefined;
	}
	// The browser starts the host with a bare environment; a login shell finds npx, uvx and friends.
	const viaShell = process.platform !== "win32";
	const child: ChildProcess = spawn(
		viaShell ? process.env.SHELL || "/bin/sh" : config.command,
		viaShell ? ["-lc", 'exec "$0" "$@"', config.command, ...(config.args ?? [])] : (config.args ?? []),
		// Its own process group: npx and friends start the real server as a child.
		{ env: { ...process.env, ...config.env }, cwd: config.cwd, stdio: ["pipe", "pipe", "ignore"], detached: viaShell },
	);
	let exitCode: number | null = null;
	child.on("exit", (code) => {
		exitCode = code;
	});
	child.on("error", (err) => send({ type: "connector_closed", error: err.message }));
	// A server that closed its input must not take the host down with an unhandled EPIPE.
	child.stdin?.on("error", (err) => send({ type: "connector_closed", error: err.message }));
	if (child.stdout) {
		const lines = createInterface({ input: child.stdout });
		// After the last line: announcing the end at process exit could overtake a final answer.
		lines.on("close", () => {
			send({ type: "connector_closed", error: exitCode ? `${name} exited with ${exitCode}` : undefined });
		});
		lines.on("line", (line) => {
			if (!line.trim()) return;
			if (Buffer.byteLength(line) <= MAX_WHOLE_BYTES) {
				try {
					send({ type: "connector_message", message: JSON.parse(line) });
				} catch {
					/* a server logging to stdout; not protocol */
				}
				return;
			}
			for (let at = 0; at < line.length; at += MAX_PART_CHARS) {
				send({ type: "connector_part", data: line.slice(at, at + MAX_PART_CHARS), last: at + MAX_PART_CHARS >= line.length });
			}
		});
	}
	return {
		write: (message) => child.stdin?.write(`${JSON.stringify(message)}\n`),
		stop: () => {
			try {
				if (viaShell && child.pid) process.kill(-child.pid, "SIGTERM");
				else child.kill();
			} catch {
				/* already gone */
			}
		},
	};
}
