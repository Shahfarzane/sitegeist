import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BridgeClient, listBrowsers, listSockets } from "./client.ts";
import { importableConnectors, readConnectors, writeConnectors } from "./connectors.ts";
import { cliCredentials } from "./credentials.ts";
import { runNativeHost } from "./host.ts";
import { install, isInstalled, launcherProblem, mcpCommand } from "./install.ts";
import { runMcpServer } from "./mcp.ts";
import { writePiExtension } from "./pi-extension.ts";
import { publishedVersion } from "./release.ts";
import { VERSION } from "./version.ts";

const HELP = `sitegeist ${VERSION} - browser bridge for coding harnesses

Usage:
  sitegeist mcp             Run the MCP server on stdio (installs the native host on first run)
  sitegeist install         Write the native messaging manifest for every Chromium browser found,
                            and have Helium install the self-hosted release when one is published here
  sitegeist status          Show whether the extension is reachable
  sitegeist browsers        List the browsers with a live bridge (SITEGEIST_BROWSER=<name> picks one)
  sitegeist reload          Reload the extension (picks up a rebuilt dist-chrome)
  sitegeist update          Make every running browser install the release published here, if newer
  sitegeist allow <host>    Allow agents to open a site (subdomains included)
  sitegeist yolo            Allow agents to open ANY site, no per-site prompts (default)
  sitegeist ask             Require a prompt before agents open an un-allowed site
  sitegeist debug           Print the extension's bridge state and recent timing log
  sitegeist connectors      List local MCP servers for the side panel agent
  sitegeist connectors add <name> -- <command> [args...]
  sitegeist connectors remove <name>
  sitegeist connectors import   Copy the command-based servers of Claude Code and Claude Desktop
  sitegeist pi-extension    Write a pi extension to ~/.pi/agent/extensions/sitegeist.ts
  sitegeist host            (internal) native messaging host, spawned by the browser
  sitegeist credentials <p> (internal) one login lookup for the host, printed as JSON

Harness setup (absolute paths: GUI apps do not inherit the shell PATH; \`sitegeist install\` prints them):
  claude mcp add --scope user sitegeist -- /opt/homebrew/opt/node@24/bin/node /opt/homebrew/bin/sitegeist mcp
  codex:  [mcp_servers.sitegeist]  command = "sitegeist"  args = ["mcp"]
  omp:    add an MCP server entry running "sitegeist mcp"
  pi:     sitegeist pi-extension
`;

function connectors(args: string[]): void {
	const current = readConnectors();
	const [action, name] = args;
	if (action === "add") {
		const separator = args.indexOf("--");
		const [command, ...commandArgs] = separator >= 0 ? args.slice(separator + 1) : [];
		if (!name || name === "--" || !command) throw new Error("usage: sitegeist connectors add <name> -- <command> [args...]");
		writeConnectors({ ...current, [name]: { command, args: commandArgs } });
		console.log(`Added ${name}. Open it in the side panel under Settings > Connectors.`);
		return;
	}
	if (action === "remove") {
		if (!name || !(name in current)) throw new Error("usage: sitegeist connectors remove <name>");
		delete current[name];
		writeConnectors(current);
		console.log(`Removed ${name}.`);
		return;
	}
	if (action === "import") {
		const found = importableConnectors();
		writeConnectors({ ...found, ...current });
		console.log(`Imported ${Object.keys(found).length} server(s): ${Object.keys(found).join(", ") || "none"}`);
		return;
	}
	const names = Object.keys(current);
	if (names.length === 0) console.log("No local connectors. Add one: sitegeist connectors add <name> -- <command> [args...]");
	for (const entry of names) console.log(`${entry}  ${current[entry].command} ${(current[entry].args ?? []).join(" ")}`);
}

async function browsers(): Promise<void> {
	const found = await listBrowsers();
	if (found.length === 0) {
		console.log("No browser with a live bridge. Is the sitegeist extension loaded in a running Chromium browser?");
		process.exitCode = 1;
		return;
	}
	for (const b of found) console.log(`${b.id}  ${b.name ?? "unknown"}  extension ${b.extensionConnected ? "connected" : "not connected"}`);
}

async function status(): Promise<void> {
	const sockets = listSockets();
	console.log(`native host manifest: ${isInstalled() ? "installed" : "missing (run: sitegeist install)"}`);
	const problem = launcherProblem();
	if (problem) {
		console.log(`host launcher: broken, ${problem} (run: sitegeist install)`);
		process.exitCode = 1;
	}
	if (sockets.length === 0) {
		console.log("bridge sockets: none. Is the sitegeist extension loaded in a running Chromium browser?");
		process.exitCode = 1;
		return;
	}
	for (const path of sockets) {
		const client = new BridgeClient({ name: "status" });
		try {
			await client.connect(path);
			console.log(`${path}: host ok, extension ${client.extensionConnected ? "connected" : "not connected"}`);
			if (client.extensionConnected) {
				const ctx = (await client.call("tabs.context", {}, 5000)) as { tabs: unknown[] };
				console.log(`  session tabs: ${ctx.tabs.length}`);
			}
		} catch (err) {
			console.log(`${path}: ${err instanceof Error ? err.message : String(err)}`);
		} finally {
			client.close();
		}
	}
}

async function main(): Promise<void> {
	const [command] = process.argv.slice(2);
	switch (command) {
		case "host":
			runNativeHost();
			return;
		case "credentials":
			// The host may be gone by now (it was terminated); the write-back has happened.
			process.stdout.on("error", () => undefined);
			process.stdout.write(JSON.stringify(await cliCredentials(process.argv[3] ?? "")));
			return;
		case "mcp":
			await runMcpServer();
			return;
		case "install": {
			const result = install({ force: process.argv.includes("--force") });
			console.log(`launcher: ${result.launcher}`);
			for (const f of result.written) console.log(`wrote   ${f}`);
			for (const f of result.skipped) console.log(`current ${f}`);
			if (result.written.length + result.skipped.length === 0) console.log("no Chromium browser profile directories found");
			console.log("Reload the sitegeist extension once if it was loaded before this install.");
			console.log(`Claude Code (every project): claude mcp add --scope user sitegeist -- ${mcpCommand().join(" ")}`);
			return;
		}
		case "browsers":
			await browsers();
			return;
		case "connectors":
			connectors(process.argv.slice(3));
			return;
		case "status":
			await status();
			return;
		case "allow": {
			const host = process.argv[3];
			if (!host) throw new Error("usage: sitegeist allow <host>");
			const client = new BridgeClient({ name: "allow" });
			await client.connect();
			console.log(JSON.stringify(await client.call("permission.allow", { host }, 5000)));
			client.close();
			return;
		}
		case "yolo":
		case "ask": {
			const mode = command === "yolo" ? "allow_all" : "ask";
			const client = new BridgeClient({ name: command });
			await client.connect();
			console.log(JSON.stringify(await client.call("permission.setMode", { mode }, 5000)));
			client.close();
			return;
		}
		case "debug": {
			const client = new BridgeClient({ name: "debug" });
			await client.connect();
			const info = (await client.call("bridge.debug", {}, 5000)) as Record<string, unknown>;
			const bench = (await client.call("bridge.bench", {}, 30000)) as Record<string, unknown>;
			console.log(JSON.stringify({ ...info, bench }, null, 2));
			client.close();
			return;
		}
		case "reload": {
			// Refuse to reload onto a broken bundle: a half-written dist-chrome unloads the extension.
			const dist = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "dist-chrome");
			const required = ["manifest.json", "background.js", "sidepanel.js", "sidepanel.html", "app.css"];
			const missing = required.filter((f) => !existsSync(join(dist, f)));
			if (existsSync(dist) && missing.length > 0) {
				throw new Error(`dist-chrome is incomplete (missing ${missing.join(", ")}); run \`npm run build\` first`);
			}
			const client = new BridgeClient({ name: "reload" });
			await client.connect();
			console.log(JSON.stringify(await client.call("bridge.reload", {}, 5000)));
			client.close();
			return;
		}
		case "update": {
			// Every running browser has its own host; each extension checks its update_url only
			// when the published version is newer than its own (an empty check is throttled for hours).
			const sockets = listSockets();
			if (sockets.length === 0) throw new Error("No running browser has the extension connected");
			const version = publishedVersion();
			for (const path of sockets) {
				const client = new BridgeClient({ name: "update" });
				try {
					await client.connect(path);
					console.log(`${path}: ${JSON.stringify(await client.call("bridge.update", version ? { version } : {}, 15000))}`);
				} catch (err) {
					console.log(`${path}: ${err instanceof Error ? err.message : String(err)}`);
				} finally {
					client.close();
				}
			}
			return;
		}
		case "pi-extension":
			console.log(`wrote ${writePiExtension(process.argv[3])}`);
			return;
		case "--version":
		case "-v":
			console.log(VERSION);
			return;
		default:
			process.stdout.write(HELP);
			if (command && command !== "--help" && command !== "-h") process.exitCode = 1;
	}
}

main().catch((err) => {
	console.error(err instanceof Error ? err.message : String(err));
	process.exit(1);
});
