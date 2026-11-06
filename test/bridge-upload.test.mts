// Files arrive at the service worker in chunks. A chunk that does not continue where the last one
// ended means the upload lost its start, and delivering the rest would hand the page a broken file.
// Run: npm test (node --import tsx --test).

import assert from "node:assert/strict";
import { test } from "node:test";
import { type HandlerContext, handlers } from "../src/bridge/tools.ts";

const ctx = { clientId: "client" } as unknown as HandlerContext;

test("chunks in order are accepted", async () => {
	await handlers["upload.chunk"](ctx, { uploadId: "a", offset: 0, data: "AAAA" });
	const result = await handlers["upload.chunk"](ctx, { uploadId: "a", offset: 4, data: "BBBB" });
	assert.deepEqual(result, { received: 8 });
});

test("a chunk after a lost start is refused", async () => {
	await assert.rejects(handlers["upload.chunk"](ctx, { uploadId: "b", offset: 600000, data: "AAAA" }), /interrupted/);
});
