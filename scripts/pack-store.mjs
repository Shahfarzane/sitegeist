// Package a production build (dist-chrome/) for the Chrome Web Store:
//   <out>/sitegeist-<version>.zip    no `key`, no `update_url`, no source maps; with --include-key
//                                    the private key rides along as key.pem, which on an item's
//                                    first upload gives the store item the id of the manifest key
//                                    (lnncppjiohlpejgcbdgoihplimdckddn)
//
// Usage:
//   node scripts/pack-store.mjs [--dir <build>] [--out <dir>]              (default release/store)
//   node scripts/pack-store.mjs --include-key <private-key.pem> --out <dir>
//
// Only the production channel goes to the store: a build under another channel's id
// (src/channels.json) is refused, so a dev build is never uploaded as the store item.

import { createPrivateKey, createPublicKey } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import JSZip from "jszip";
import { extensionIdForKey, readChannel } from "./channel-build.mjs";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

const { values: args } = parseArgs({
	options: {
		dir: { type: "string", default: join(packageRoot, "dist-chrome") },
		out: { type: "string" },
		"include-key": { type: "string" },
	},
});
const outDir = args.out ?? join(packageRoot, "release/store");
const { channels } = readChannel(packageRoot, "production");
const otherChannel = (id) =>
	Object.entries(channels).find(([name, c]) => name !== "production" && c.extensionId === id)?.[0];

const listFiles = (dir) =>
	readdirSync(dir).flatMap((name) => {
		const path = join(dir, name);
		return statSync(path).isDirectory() ? listFiles(path) : [path];
	});

const buildZip = async (manifest, extraFiles = {}) => {
	const zip = new JSZip();
	// Fixed timestamps keep the archive byte-identical for identical input.
	const date = new Date("2000-01-01T00:00:00Z");
	for (const path of listFiles(args.dir).sort()) {
		const name = relative(args.dir, path).split("\\").join("/");
		if (name.endsWith(".map") || name === ".DS_Store") continue;
		const content = name === "manifest.json" ? `${JSON.stringify(manifest, null, "\t")}\n` : readFileSync(path);
		zip.file(name, content, { date });
	}
	for (const [name, content] of Object.entries(extraFiles)) zip.file(name, content, { date });
	return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 9 } });
};

// The Web Store rejects an upload whose manifest carries `key`, and it serves updates itself.
// The id comes from key.pem instead, read only on the item's first upload.
const run = async () => {
	const manifest = JSON.parse(readFileSync(join(args.dir, "manifest.json"), "utf8"));
	const id = manifest.key ? extensionIdForKey(manifest.key) : undefined;
	if (otherChannel(id))
		throw new Error(
			`this is a ${otherChannel(id)} build (${id}); the store takes the production build: npm run build`,
		);
	delete manifest.key;
	delete manifest.update_url;
	const extraFiles = {};
	if (args["include-key"]) {
		// key.pem fixes the store item's id for good, so it must be the key production builds use,
		// and a zip holding it goes only where the caller asked (store-zip.sh: a temp folder).
		if (!id) throw new Error("--include-key needs the manifest's `key` to check the id against");
		if (!args.out) throw new Error("--include-key needs --out: the zip holds the private key");
		const pem = readFileSync(args["include-key"], "utf8");
		const publicKey = createPublicKey(createPrivateKey(pem)).export({ type: "spki", format: "der" });
		const keyId = extensionIdForKey(publicKey.toString("base64"));
		if (keyId !== id) throw new Error(`key.pem (id ${keyId}) does not match the manifest key (id ${id})`);
		extraFiles["key.pem"] = pem;
	}
	mkdirSync(outDir, { recursive: true });
	const zipPath = join(outDir, `sitegeist-${manifest.version}.zip`);
	writeFileSync(zipPath, await buildZip(manifest, extraFiles));
	console.log(zipPath);
};

run().catch((error) => {
	console.error(error.message ?? error);
	process.exitCode = 1;
});
