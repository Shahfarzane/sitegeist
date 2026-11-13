import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import JSZip from "jszip";

const packCrx = join(import.meta.dirname, "../scripts/pack-crx.mjs");
const work = mkdtempSync(join(tmpdir(), "pack-store-"));
after(() => rmSync(work, { recursive: true, force: true }));

const newKey = () => generateKeyPairSync("rsa", { modulusLength: 2048 });
const pem = (key: ReturnType<typeof newKey>) => key.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const key = newKey();

const dist = join(work, "dist");
execFileSync("mkdir", ["-p", dist]);
writeFileSync(
	join(dist, "manifest.json"),
	JSON.stringify({
		manifest_version: 3,
		name: "test",
		version: "1.2.3",
		key: key.publicKey.export({ type: "spki", format: "der" }).toString("base64"),
		update_url: "file:///tmp/updates.xml",
	}),
);
writeFileSync(join(dist, "background.js"), "");
writeFileSync(join(dist, "background.js.map"), "{}");

const pack = (out: string, ...args: string[]) =>
	spawnSync(process.execPath, [packCrx, "--store", "--dir", dist, "--out", out, ...args], { encoding: "utf8" });

const read = async (zipPath: string) => JSZip.loadAsync(readFileSync(zipPath));

test("the store zip drops key and update_url, source maps, and adds no key.pem", async () => {
	const result = pack(join(work, "plain"));
	assert.equal(result.status, 0, result.stderr);
	const zip = await read(result.stdout.trim());
	assert.deepEqual(Object.keys(zip.files).sort(), ["background.js", "manifest.json"]);
	const manifest = JSON.parse(await zip.file("manifest.json")!.async("string"));
	assert.equal(manifest.key, undefined);
	assert.equal(manifest.update_url, undefined);
	assert.equal(manifest.version, "1.2.3");
});

test("--include-key puts the matching private key at the zip root as key.pem", async () => {
	const keyFile = join(work, "key.pem");
	writeFileSync(keyFile, pem(key));
	const result = pack(join(work, "first"), "--include-key", keyFile);
	assert.equal(result.status, 0, result.stderr);
	const zip = await read(result.stdout.trim());
	assert.equal(await zip.file("key.pem")!.async("string"), pem(key));
	assert.equal(JSON.parse(await zip.file("manifest.json")!.async("string")).key, undefined);
});

test("--include-key refuses a key that would give the item another id", () => {
	const otherFile = join(work, "other.pem");
	writeFileSync(otherFile, pem(newKey()));
	const result = pack(join(work, "wrong"), "--include-key", otherFile);
	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /does not match the manifest key/);
});
