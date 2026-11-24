import { chmodSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { readChannel } from "../../scripts/channel-build.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
// SITEGEIST_CHANNEL=dev builds the dev copy's CLI into dist-dev/: its own native host, launcher
// and socket folder (src/channels.json). dist/ stays the production CLI that `npm link` installs.
const { name: channelName, channel } = readChannel(join(root, ".."));
const outDir = join(root, channel.cliOutDir);
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

await build({
	absWorkingDir: root,
	entryPoints: { index: join(root, "src/index.ts") },
	bundle: true,
	platform: "node",
	target: ["node20"],
	format: "esm",
	outdir: outDir,
	banner: { js: "#!/usr/bin/env node" },
	// Bundle everything (incl. the MCP SDK and zod) so the CLI is self-contained and runs
	// from a global link or npx without a node_modules next to dist.
	packages: "bundle",
	sourcemap: true,
	logLevel: "info",
	// src/channel.ts: the CLI knows its channel and never reads it from the environment.
	define: { "process.env.SITEGEIST_CHANNEL": JSON.stringify(channelName) },
});
chmodSync(join(outDir, "index.js"), 0o755);
