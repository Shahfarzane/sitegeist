// Self-update asks Chrome only when a newer release is published: an empty check arms a
// 5-hour throttle, which used to swallow the push after every release.
// Run: npm test (node --import tsx --test).

import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { checkForUpdate, isNewerVersion } from "../src/utils/self-update.ts";

let checks = 0;

beforeEach(() => {
	checks = 0;
	(globalThis as { chrome?: unknown }).chrome = {
		runtime: {
			getManifest: () => ({ version: "1.2.322" }),
			requestUpdateCheck: async () => {
				checks++;
				return { status: "update_available", version: "1.2.330" };
			},
		},
	};
});

const quiet = () => undefined;

test("compares dotted versions numerically", () => {
	assert.equal(isNewerVersion("1.2.330", "1.2.322"), true);
	assert.equal(isNewerVersion("1.10.0", "1.9.99"), true);
	assert.equal(isNewerVersion("1.2.322", "1.2.322"), false);
	assert.equal(isNewerVersion("1.2.3", "1.2.322"), false);
	assert.equal(isNewerVersion("1.3", "1.2.322"), true);
	assert.equal(isNewerVersion("garbage", "1.2.322"), false);
});

test("skips the check when the published release is not newer", async () => {
	assert.deepEqual(await checkForUpdate("1.2.322", quiet, "test"), { status: "current" });
	assert.deepEqual(await checkForUpdate("1.2.300", quiet, "test"), { status: "current" });
	assert.equal(checks, 0);
});

test("asks Chrome when the published release is newer", async () => {
	assert.deepEqual(await checkForUpdate("1.2.330", quiet, "test"), { status: "update_available", version: "1.2.330" });
	assert.equal(checks, 1);
});

test("asks Chrome when an older CLI sends no version", async () => {
	await checkForUpdate(undefined, quiet, "test");
	assert.equal(checks, 1);
});
