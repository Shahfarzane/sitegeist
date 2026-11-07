// Self-update on the real path: the native host reads updates.xml and the extension asks Chrome
// only when that release is newer. An empty check arms Chrome's 5-hour throttle, which used to
// swallow the push after every release.
// Run: SITEGEIST_VERSION=9.9.9 node scripts/build.mjs && (cd cli && npm run build) && npm run test:e2e

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { Browser, bridgeReady, EXTENSION_ID, repoRoot } from "./lib.mjs";

const cli = join(repoRoot, "cli/dist/index.js");
let browser;
let updateDir;

const publish = (version) =>
	writeFileSync(
		join(updateDir, "updates.xml"),
		`<?xml version="1.0" encoding="UTF-8"?>
<gupdate xmlns="http://www.google.com/update2/response" protocol="2.0">
  <app appid="${EXTENSION_ID}">
    <updatecheck codebase="file://${updateDir}/sitegeist-${version}.crx" version="${version}" />
  </app>
</gupdate>
`,
	);

/** One bridge request over the host socket, answered by the extension. */
function bridgeCall(method, params = {}) {
	const [sock] = readdirSync(browser.socketDir).filter((n) => n.endsWith(".sock"));
	return new Promise((resolve, reject) => {
		const socket = connect(join(browser.socketDir, sock));
		const frame = (message) => {
			const body = Buffer.from(JSON.stringify(message));
			const header = Buffer.alloc(4);
			header.writeUInt32LE(body.length, 0);
			return Buffer.concat([header, body]);
		};
		let buffer = Buffer.alloc(0);
		const timer = setTimeout(() => reject(new Error(`${method} timed out`)), 15000);
		socket.on("connect", () => {
			socket.write(frame({ type: "hello", client: { name: "e2e-update", session: "e2e-update" } }));
			socket.write(frame({ type: "request", id: 1, method, params }));
		});
		socket.on("data", (chunk) => {
			buffer = Buffer.concat([buffer, chunk]);
			while (buffer.length >= 4 && buffer.length >= 4 + buffer.readUInt32LE(0)) {
				const message = JSON.parse(buffer.subarray(4, 4 + buffer.readUInt32LE(0)).toString("utf8"));
				buffer = buffer.subarray(4 + buffer.readUInt32LE(0));
				if (message.type === "response" && message.id === 1) {
					clearTimeout(timer);
					socket.destroy();
					if (message.error) reject(new Error(message.error.message));
					else resolve(message.result);
				}
			}
		});
		socket.on("error", reject);
	});
}

const updateChecks = async () => (await bridgeCall("bridge.debug")).log.filter((line) => line.includes("update check"));

function sitegeistUpdate() {
	const out = execFileSync(process.execPath, [cli, "update"], {
		env: { ...process.env, SITEGEIST_SOCKET_DIR: browser.socketDir, SITEGEIST_UPDATE_DIR: updateDir },
		encoding: "utf8",
	});
	return JSON.parse(out.slice(out.indexOf("{")));
}

async function waitFor(predicate, timeoutMs = 10000) {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = await predicate();
		if (value) return value;
		if (Date.now() > deadline) throw new Error("timed out");
		await new Promise((r) => setTimeout(r, 100));
	}
}

before(async () => {
	updateDir = mkdtempSync(join(tmpdir(), "sitegeist-e2e-update-"));
	publish("10.0.0");
	browser = await Browser.launch({ bridge: true, env: { SITEGEIST_UPDATE_DIR: updateDir } });
	await browser.worker();
	await bridgeReady(browser);
});

after(async () => {
	await browser?.close();
	rmSync(updateDir, { recursive: true, force: true });
});

test("the host announces a newer release on connect and the extension checks once", async () => {
	const lines = await waitFor(async () => {
		const found = await updateChecks();
		return found.length > 0 ? found : undefined;
	});
	assert.equal(lines.length, 1);
	assert.match(lines[0], /update check \(host\): .* \(published 10\.0\.0\)/);
});

test("`sitegeist update` leaves Chrome alone when the published release is not newer", async () => {
	publish("1.0.0");
	const before = (await updateChecks()).length;
	const result = sitegeistUpdate();
	assert.equal(result.status, "current");
	assert.equal(result.installed, "9.9.9");
	assert.equal((await updateChecks()).length, before);
});

test("`sitegeist update` asks Chrome when the published release is newer", async () => {
	publish("10.0.1");
	const result = sitegeistUpdate();
	assert.notEqual(result.status, "current");
	const lines = await updateChecks();
	assert.match(lines.at(-1), /update check \(sitegeist update\): .* \(published 10\.0\.1\)/);
});
