// The dev channel's bridge stays apart from production's: its own native host name, launcher,
// socket folder and extension id, and `install` never touches the production host's files.
// Each case runs the CLI's modules in a child process, because the channel is read once, at
// import (a built CLI has it compiled in).

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const src = import.meta.dirname;
const work = mkdtempSync(join(tmpdir(), "sitegeist-channel-"));
after(() => rmSync(work, { recursive: true, force: true }));

const PRODUCTION_ID = "lnncppjiohlpejgcbdgoihplimdckddn";
const DEV_ID = "jdoloceeppngimcgcjcopnammjaaggim";

/** Runs `body` (TypeScript, with the CLI modules imported) under a channel and a home folder. */
function probe(channel: "production" | "dev", home: string, body: string, env: Record<string, string> = {}): unknown {
	const file = join(work, `probe-${Math.random().toString(36).slice(2)}.ts`);
	writeFileSync(
		file,
		`import { NATIVE_HOST_NAME } from ${JSON.stringify(join(src, "../../src/bridge/protocol.ts"))};
import { EXTENSION_ID, install } from ${JSON.stringify(join(src, "install.ts"))};
import { socketDir } from ${JSON.stringify(join(src, "paths.ts"))};
import { publishedVersion } from ${JSON.stringify(join(src, "release.ts"))};
import { writePiExtension } from ${JSON.stringify(join(src, "pi-extension.ts"))};
void NATIVE_HOST_NAME, EXTENSION_ID, install, socketDir, publishedVersion, writePiExtension;
process.stdout.write(JSON.stringify(${body}));
`,
	);
	const { SITEGEIST_SOCKET_DIR: _socket, SITEGEIST_UPDATE_DIR: _update, ...inherited } = process.env;
	const result = spawnSync(process.execPath, ["--import", "tsx", file], {
		cwd: join(src, ".."),
		encoding: "utf8",
		env: { ...inherited, HOME: home, SITEGEIST_CHANNEL: channel, ...env },
	});
	assert.equal(result.status, 0, result.stderr);
	return JSON.parse(result.stdout);
}

/** Every file under `dir`, path to content. */
function snapshot(dir: string, prefix = ""): Map<string, string> {
	const files = new Map<string, string>();
	for (const name of readdirSync(dir)) {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) for (const [k, v] of snapshot(path, `${prefix}${name}/`)) files.set(k, v);
		else files.set(`${prefix}${name}`, readFileSync(path, "utf8"));
	}
	return files;
}

test("production keeps its host name, socket folder and id; dev has its own", () => {
	const home = mkdtempSync(join(work, "home-"));
	const user = userInfo().username;
	const ask = `{ host: NATIVE_HOST_NAME, sockets: socketDir(), id: EXTENSION_ID }`;
	assert.deepEqual(probe("production", home, ask), {
		host: "ai.sitegeist.bridge",
		sockets: `/tmp/sitegeist-bridge-${user}`,
		id: PRODUCTION_ID,
	});
	assert.deepEqual(probe("dev", home, ask), {
		host: "ai.sitegeist.bridge.dev",
		sockets: `/tmp/sitegeist-bridge-dev-${user}`,
		id: DEV_ID,
	});
});

test("dev install registers the dev host and leaves every production file as it was", () => {
	const home = mkdtempSync(join(work, "home-"));
	// One browser folder for each platform install.ts knows, plus Helium (external installs).
	for (const dir of ["Library/Application Support/Google/Chrome", "Library/Application Support/net.imput.helium", ".config/google-chrome"]) {
		mkdirSync(join(home, dir), { recursive: true });
	}
	// A release published on this machine: production also writes Helium's external-install file.
	const updates = mkdtempSync(join(work, "updates-"));
	writeFileSync(join(updates, "updates.xml"), `<gupdate><app appid="${PRODUCTION_ID}"><updatecheck codebase="file:///x.crx" version="1.2.400" /></app></gupdate>`);
	const env = { SITEGEIST_UPDATE_DIR: updates };

	probe("production", home, "install()", env);
	const before = snapshot(home);
	assert.ok([...before.keys()].some((k) => k.endsWith("NativeMessagingHosts/ai.sitegeist.bridge.json")));

	assert.equal(probe("dev", home, "publishedVersion() ?? null", env), null);
	assert.equal(probe("production", home, "publishedVersion() ?? null", env), "1.2.400");
	probe("dev", home, "install()", env);
	const afterDev = snapshot(home);

	for (const [path, content] of before) assert.equal(afterDev.get(path), content, `${path} changed`);
	const added = [...afterDev.keys()].filter((k) => !before.has(k)).sort();
	assert.ok(added.includes(".config/sitegeist/host-dev"), added.join(", "));
	assert.ok(!added.some((k) => k.includes("External Extensions")), added.join(", "));
	const manifests = added.filter((k) => k.endsWith("/NativeMessagingHosts/ai.sitegeist.bridge.dev.json"));
	assert.equal(manifests.length, added.length - 1, added.join(", "));
	assert.ok(manifests.length >= 1);
	for (const path of manifests) {
		const manifest = JSON.parse(afterDev.get(path) ?? "");
		assert.equal(manifest.name, "ai.sitegeist.bridge.dev");
		assert.deepEqual(manifest.allowed_origins, [`chrome-extension://${DEV_ID}/`]);
		assert.equal(manifest.path, join(home, ".config/sitegeist/host-dev"));
	}
});

test("the dev pi extension has its own file, sockets and tool names", () => {
	const home = mkdtempSync(join(work, "home-"));
	const dir = join(home, "extensions");
	const devFile = probe("dev", home, `writePiExtension(${JSON.stringify(dir)})`) as string;
	const prodFile = probe("production", home, `writePiExtension(${JSON.stringify(dir)})`) as string;
	assert.equal(devFile, join(dir, "sitegeist-dev.ts"));
	assert.equal(prodFile, join(dir, "sitegeist.ts"));
	const dev = readFileSync(devFile, "utf8");
	const prod = readFileSync(prodFile, "utf8");
	assert.match(dev, /\/tmp\/sitegeist-bridge-dev-/);
	assert.match(dev, /name: "dev_browser_tabs"/);
	assert.doesNotMatch(dev, /name: "browser_tabs"/);
	assert.match(prod, /\/tmp\/sitegeist-bridge-\$\{/);
	assert.match(prod, /name: "browser_tabs"/);
	assert.ok(existsSync(devFile) && existsSync(prodFile));
});
