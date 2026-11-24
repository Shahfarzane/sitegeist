// `sitegeist update` asks Chrome for one store check now and reports its answer.
// Run: npm test (node --import tsx --test).

import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { checkForUpdate } from "../src/utils/self-update.ts";

let checks = 0;
let session: Record<string, unknown> = {};

beforeEach(() => {
	checks = 0;
	session = {};
	(globalThis as { chrome?: unknown }).chrome = {
		storage: {
			session: {
				get: async (key: string) => (key in session ? { [key]: session[key] } : {}),
				set: async (items: Record<string, unknown>) => Object.assign(session, items),
			},
		},
		runtime: {
			getManifest: () => ({ version: "1.2.322" }),
			requestUpdateCheck: async () => {
				checks++;
				return { status: "update_available", version: "1.2.330" };
			},
		},
	};
});

const lines: string[] = [];

test("asks Chrome once and reports its answer", async () => {
	lines.length = 0;
	assert.deepEqual(await checkForUpdate((line) => lines.push(line), "sitegeist update"), {
		status: "update_available",
		version: "1.2.330",
	});
	assert.equal(checks, 1);
	assert.deepEqual(lines, ["update check (sitegeist update): update_available 1.2.330"]);
	assert.deepEqual(session, {});
});
