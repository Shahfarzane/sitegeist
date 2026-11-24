import { execSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, watch, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build, context } from "esbuild";
import { channelCorsRules, channelManifest, devVersion, extensionIdForKey, readChannel } from "./channel-build.mjs";
import { markIcon } from "./mark-icon.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const packageRoot = join(__dirname, "..");
const isWatch = process.argv.includes("--watch");
const staticDir = join(packageRoot, "static");

// Chrome only
const targetBrowser = "chrome";
// SITEGEIST_CHANNEL=dev builds the copy loaded unpacked beside the store copy (src/channels.json);
// production, the default, is the store item.
const { name: channelName, channel, channels } = readChannel(packageRoot);
const outDir = join(packageRoot, channel.outDir);

const entryPoints = {
	sidepanel: join(packageRoot, "src/sidepanel.ts"),
	debug: join(packageRoot, "src/debug.ts"),
	icons: join(packageRoot, "src/icons.ts"),
	background: join(packageRoot, "src/background.ts"),
	offscreen: join(packageRoot, "src/offscreen.ts"),
	"gif-worker": join(packageRoot, "src/recording/gif-worker.ts"),
};

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

// The reload script (src/utils/live-reload.ts) connects to `npm run dev`'s server on
// localhost:8765 and reloads the extension on every rebuild. Only the dev channel carries it:
// the store build opens no localhost socket, and a dev rebuild never reloads the store copy.
const liveReloadOnlyInDev = {
	name: "live-reload-only-in-dev",
	setup(build) {
		if (channel.liveReload) return;
		build.onResolve({ filter: /\/live-reload\.js$/ }, (args) => ({ path: args.path, namespace: "left-out" }));
		build.onLoad({ filter: /.*/, namespace: "left-out" }, () => ({ contents: "", loader: "js" }));
	},
};

const buildOptions = {
	absWorkingDir: packageRoot,
	entryPoints,
	bundle: true,
	outdir: outDir,
	format: "esm",
	target: ["chrome120"],
	platform: "browser",
	sourcemap: isWatch ? "inline" : true,
	// Half the size: every panel parses this bundle, and they share one renderer main thread.
	// Not minifySyntax: page scripts are built from Function.toString() and placeholders in the
	// source (tools/repl/userscripts-helpers.ts), which syntax rewriting removes or folds away.
	minifyWhitespace: !isWatch,
	minifyIdentifiers: !isWatch,
	entryNames: "[name]",
	loader: {
		".ts": "ts",
		".tsx": "tsx",
	},
	define: {
		"process.env.NODE_ENV": JSON.stringify(process.env.NODE_ENV ?? (isWatch ? "development" : "production")),
		"process.env.TARGET_BROWSER": JSON.stringify(targetBrowser),
		// src/channel.ts: the bundle knows its channel and never reads it at run time.
		"process.env.SITEGEIST_CHANNEL": JSON.stringify(channelName),
		global: "globalThis",
	},
	inject: [join(packageRoot, "scripts/process-shim.js")],
	plugins: [liveReloadOnlyInDev],
	// Let bare imports inside the bundled pi-mono source resolve against pi-mono's
	// installed dependencies (openai, @anthropic-ai/sdk, typebox, ...).
	nodePaths: [join(packageRoot, "../pi-mono/node_modules")],
	// Force all mini-lit and lit imports to resolve to sitegeist's node_modules
	alias: {
		process: join(packageRoot, "scripts/process-shim.js"),
		"@mariozechner/mini-lit": join(packageRoot, "node_modules/@mariozechner/mini-lit"),
		// Bundle the sibling pi-mono packages straight from TypeScript source. Their
		// published entrypoints are dist/ builds that require the tsgo toolchain; pointing
		// esbuild at src/ lets us build without pre-compiling them.
		"@mariozechner/pi-ai": join(packageRoot, "../pi-mono/packages/ai/src/index.ts"),
		"@mariozechner/pi-agent-core": join(packageRoot, "../pi-mono/packages/agent/src/index.ts"),
		"@mariozechner/pi-web-ui": join(packageRoot, "../pi-mono/packages/web-ui/src/index.ts"),
		lit: join(packageRoot, "node_modules/lit"),
		"lit/decorators.js": join(packageRoot, "node_modules/lit/decorators.js"),
		"lit/directives/class-map.js": join(packageRoot, "node_modules/lit/directives/class-map.js"),
		"lit/directives/unsafe-html.js": join(packageRoot, "node_modules/lit/directives/unsafe-html.js"),
	},
};

// ============================================================================
// VERSIONING
// ============================================================================
// Every production build bumps the version. Each component runs 1..10; when one
// would exceed 10 it rolls over to 1 and the next-higher component increments:
//   1.1.1 -> 1.1.2 -> ... -> 1.1.10 -> 1.2.1 -> ... -> 1.10.10 -> 2.1.1 -> ...
// Major caps at 10 (stays at 10.10.10). Watch/dev rebuilds do NOT bump.
const computeNextVersion = (version) => {
	const parts = String(version)
		.split(".")
		.map((p) => Number.parseInt(p, 10));
	let [major, minor, patch] = parts;
	// If the current version is outside the 1..10 scheme, snap to the baseline.
	const inScheme = [major, minor, patch].every((n) => Number.isInteger(n) && n >= 1 && n <= 10);
	if (!inScheme) return "1.1.1";
	patch += 1;
	if (patch > 10) {
		patch = 1;
		minor += 1;
	}
	if (minor > 10) {
		minor = 1;
		major += 1;
	}
	if (major > 10) {
		return "10.10.10"; // cap
	}
	return `${major}.${minor}.${patch}`;
};

const bumpVersion = () => {
	const manifestPath = join(packageRoot, "static/manifest.chrome.json");
	const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
	const current = manifest.version || "1.0.0";
	const next = computeNextVersion(current);
	if (next === current) {
		console.log(`Version: ${current} (capped)`);
		return next;
	}
	manifest.version = next;
	writeFileSync(manifestPath, `${JSON.stringify(manifest, null, "\t")}\n`);

	// Keep package.json in sync so the repo version matches the shipped manifest.
	try {
		const pkgPath = join(packageRoot, "package.json");
		const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
		pkg.version = next;
		writeFileSync(pkgPath, `${JSON.stringify(pkg, null, "\t")}\n`);
	} catch {
		// non-fatal
	}

	console.log(`Version: ${current} -> ${next}`);
	return next;
};

// Get all files from static directory
const getStaticFiles = () => {
	return readdirSync(staticDir).map((file) => join("static", file));
};

// The commit a dev build names. Read once: a watch build keeps the name it started with.
const gitStamp = () => {
	const git = (...args) => execSync(`git ${args.join(" ")}`, { cwd: packageRoot, encoding: "utf8" }).trim();
	try {
		return {
			commits: git("rev-list", "--count", "HEAD"),
			sha: git("rev-parse", "--short", "HEAD"),
			branch: git("rev-parse", "--abbrev-ref", "HEAD"),
			modified: git("status", "--porcelain") !== "",
		};
	} catch {
		return undefined;
	}
};
const devStamp = channel.manifest ? gitStamp() : undefined;

const copyStatic = () => {
	// Use browser-specific manifest
	const manifestSource = join(packageRoot, `static/manifest.${targetBrowser}.json`);
	const manifestDest = join(outDir, "manifest.json");
	const sourceManifest = JSON.parse(readFileSync(manifestSource, "utf8"));
	if (extensionIdForKey(sourceManifest.key) !== channels.production.extensionId) {
		throw new Error(`the key in ${manifestSource} is not the store item's (${channels.production.extensionId})`);
	}
	if (channel.manifest) {
		// A dev build never bumps the tracked version; it pins one that names the commit.
		const stamp = devVersion(sourceManifest.version, devStamp);
		const manifest = channelManifest(sourceManifest, channel, {
			version: process.env.SITEGEIST_VERSION ?? stamp.version,
			versionName: process.env.SITEGEIST_VERSION_NAME ?? stamp.versionName,
		});
		writeFileSync(manifestDest, `${JSON.stringify(manifest, null, "\t")}\n`);
	} else {
		copyFileSync(manifestSource, manifestDest);
	}

	// Copy all files from static/ directory (except manifest files)
	const staticFiles = getStaticFiles();
	for (const relative of staticFiles) {
		const filename = relative.replace("static/", "");
		// Skip manifest files - we already copied the correct one above
		if (filename.startsWith("manifest.")) continue;

		const source = join(packageRoot, relative);
		const destination = join(outDir, filename);
		if (filename === "cors-rules.json") {
			const rules = channelCorsRules(
				readFileSync(source, "utf8"),
				channels.production.extensionId,
				channel.extensionId,
			);
			writeFileSync(destination, rules);
			continue;
		}
		copyFileSync(source, destination);
	}
	if (channel.manifest) {
		for (const icon of new Set(Object.values(sourceManifest.icons))) {
			writeFileSync(join(outDir, icon), markIcon(readFileSync(join(staticDir, icon))));
		}
	}

	// Copy PDF.js worker from node_modules (check both local and monorepo root)
	let pdfWorkerSource = join(packageRoot, "node_modules/pdfjs-dist/build/pdf.worker.min.mjs");
	if (!existsSync(pdfWorkerSource)) {
		pdfWorkerSource = join(packageRoot, "../../node_modules/pdfjs-dist/build/pdf.worker.min.mjs");
	}
	const pdfWorkerDestDir = join(outDir, "pdfjs-dist/build");
	mkdirSync(pdfWorkerDestDir, { recursive: true });
	const pdfWorkerDest = join(pdfWorkerDestDir, "pdf.worker.min.mjs");
	copyFileSync(pdfWorkerSource, pdfWorkerDest);

	console.log(`Built the ${channelName} channel for ${targetBrowser} in ${outDir}`);
};

const run = async () => {
	if (isWatch) {
		const ctx = await context(buildOptions);
		await ctx.watch();
		copyStatic();

		// Watch the entire static directory
		watch(staticDir, { recursive: true }, (eventType) => {
			if (eventType === "change") {
				console.log(`\nStatic files changed, copying...`);
				copyStatic();
			}
		});

		// Watch the manifest file for the target browser
		const manifestSource = join(packageRoot, `static/manifest.${targetBrowser}.json`);
		watch(manifestSource, (eventType) => {
			if (eventType === "change") {
				console.log(`\nManifest changed, copying...`);
				copyStatic();
			}
		});

		process.stdout.write("Watching for changes...\n");
	} else {
		// Releases pin the version (SITEGEIST_VERSION, derived from git by release-crx.sh) and
		// leave the source manifest alone; plain production builds keep the auto-bump. Dev builds
		// pin theirs in copyStatic and never bump.
		const pinned = process.env.SITEGEIST_VERSION;
		if (!pinned && !channel.manifest) bumpVersion();
		await build(buildOptions);
		copyStatic();
		if (pinned && !channel.manifest) {
			const distManifestPath = join(outDir, "manifest.json");
			const distManifest = JSON.parse(readFileSync(distManifestPath, "utf8"));
			distManifest.version = pinned;
			if (process.env.SITEGEIST_VERSION_NAME) distManifest.version_name = process.env.SITEGEIST_VERSION_NAME;
			writeFileSync(distManifestPath, `${JSON.stringify(distManifest, null, "\t")}\n`);
			console.log(`Version: ${pinned} (pinned)`);
		}
		// The stylesheet is generated by Tailwind; without it the side panel renders unstyled.
		// `npm run build` also runs this step, but a direct invocation must produce a complete bundle.
		execSync(`npx tailwindcss -i ./src/app.css -o ./${channel.outDir}/app.css --minify`, {
			cwd: packageRoot,
			stdio: "inherit",
		});
	}
};

run().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
