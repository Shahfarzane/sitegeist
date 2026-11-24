// The build channel: production is the store item as the source has it, dev is a second copy
// with its own id, name, icons and folder. Run: npm test (node --import tsx --test).

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
	channelCorsRules,
	channelManifest,
	devVersion,
	extensionIdForKey,
	readChannel,
} from "../scripts/channel-build.mjs";
import { decodePng, markIcon } from "../scripts/mark-icon.mjs";

const root = join(import.meta.dirname, "..");
const { channels } = readChannel(root, "production");
const { production, dev } = channels;
const source = JSON.parse(readFileSync(join(root, "static/manifest.chrome.json"), "utf8"));
const corsText = readFileSync(join(root, "static/cors-rules.json"), "utf8");

test("each channel's id is the id of its key, and the two differ", () => {
	assert.equal(extensionIdForKey(source.key), production.extensionId);
	assert.equal(production.extensionId, "lnncppjiohlpejgcbdgoihplimdckddn");
	assert.equal(extensionIdForKey(dev.manifest.key), dev.extensionId);
	assert.notEqual(dev.extensionId, production.extensionId);
	assert.notEqual(dev.outDir, production.outDir);
});

test("production changes nothing in the manifest; SITEGEIST_CHANNEL picks the channel", () => {
	assert.equal(production.manifest, undefined);
	assert.equal(readChannel(root, undefined).name, "production");
	assert.deepEqual(readChannel(root, "dev").channel, dev);
	assert.throws(() => readChannel(root, "staging"), /must be one of: production, dev/);
});

test("the dev manifest has its own name, key and title, and keeps everything else", () => {
	const manifest = channelManifest(source, dev, { version: "1.2.400", versionName: "1.2.400 dev (main abc1234)" });
	assert.equal(manifest.name, "Sitegeist Bridge DEV (unofficial fork)");
	assert.equal(extensionIdForKey(manifest.key), dev.extensionId);
	assert.match(manifest.action.default_title, /DEV/);
	assert.equal(manifest.version, "1.2.400");
	assert.equal(manifest.version_name, "1.2.400 dev (main abc1234)");
	assert.deepEqual(manifest.permissions, source.permissions);
	assert.deepEqual(manifest.host_permissions, source.host_permissions);
	assert.equal(manifest.update_url, undefined);
	// The source object is left as it was.
	assert.equal(extensionIdForKey(source.key), production.extensionId);
});

test("a key that does not give the channel's id fails the build", () => {
	const drifted = { ...dev, manifest: { ...dev.manifest, key: source.key } };
	assert.throws(() => channelManifest(source, drifted, { version: "1.0.0" }), /src\/channels\.json says/);
});

test("the Anthropic CORS rule names the built channel's id", () => {
	assert.equal(channelCorsRules(corsText, production.extensionId, production.extensionId), corsText);
	const devRules = JSON.parse(channelCorsRules(corsText, production.extensionId, dev.extensionId));
	const sourceRules = JSON.parse(corsText);
	const bound = devRules.filter((r: { condition: { initiatorDomains?: string[] } }) => r.condition.initiatorDomains);
	assert.equal(bound.length, 1);
	assert.equal(bound[0].condition.urlFilter, "||api.anthropic.com");
	assert.deepEqual(bound[0].condition.initiatorDomains, [dev.extensionId]);
	assert.doesNotMatch(JSON.stringify(devRules), new RegExp(production.extensionId));
	// Only the initiator changes.
	const strip = (rules: Array<{ condition: Record<string, unknown> }>) =>
		rules.map((r) => ({ ...r, condition: { ...r.condition, initiatorDomains: undefined } }));
	assert.deepEqual(strip(devRules), strip(sourceRules));
	assert.throws(() => channelCorsRules("[]", production.extensionId, dev.extensionId), /no rule for initiator/);
});

test("a dev version counts commits like a release and names the branch and commit", () => {
	assert.deepEqual(devVersion("1.2.3", { commits: "364", sha: "abc1234", branch: "feat/x", modified: true }), {
		version: "1.2.364",
		versionName: "1.2.364 dev (feat/x abc1234, modified)",
	});
	assert.equal(devVersion("1.2.3", { commits: "7", sha: "abc1234", branch: "main", modified: false }).versionName, "1.2.7 dev (main abc1234)");
	assert.deepEqual(devVersion("1.2.3", undefined), { version: "1.2.3", versionName: "1.2.3 dev" });
});

test("the dev icons carry a green dot in the corner and keep the rest", () => {
	for (const size of [16, 48, 128]) {
		const png = readFileSync(join(root, `static/icon-${size}.png`));
		const before = decodePng(png);
		const after = decodePng(markIcon(png));
		assert.equal(after.width, size);
		assert.equal(after.height, size);
		const at = (image: typeof before, x: number, y: number) => [...image.pixels.subarray((y * size + x) * 4, (y * size + x) * 4 + 4)];
		const corner = at(after, size - Math.ceil(size * 0.2), size - Math.ceil(size * 0.2));
		assert.ok(corner[1] > 150 && corner[0] < 100 && corner[3] === 255, `size ${size}: corner ${corner}`);
		assert.deepEqual(at(after, 1, 1), at(before, 1, 1));
		assert.deepEqual(at(after, size >> 2, size >> 2), at(before, size >> 2, size >> 2));
	}
});
