// What the recording shows at each moment.
// Run: npm test (node --import tsx --test).

import assert from "node:assert/strict";
import { test } from "node:test";
import { GifRecorder } from "../src/recording/gif-recorder.ts";

type Internals = {
	frames: Array<{ data: string; at: number; viewportWidth: number }>;
	actions: Array<Record<string, unknown>>;
	timeline(): Array<{ overlays: unknown[]; viewportWidth: number; label?: string }>;
};

test("a click marker fades, also on the last frame", () => {
	const recorder = new GifRecorder() as unknown as Internals;
	recorder.frames = [
		{ data: "a", at: 0, viewportWidth: 1280 },
		{ data: "b", at: 500, viewportWidth: 1280 },
		{ data: "c", at: 5000, viewportWidth: 1280 },
	];
	recorder.actions = [{ kind: "click", x: 1, y: 1, label: "Click", at: 100 }];
	const frames = recorder.timeline();
	assert.equal(frames[0].overlays.length, 1);
	assert.equal(frames[2].overlays.length, 0);
	assert.equal(frames[2].label, "Click");
});

test("every frame keeps the page width it was taken at", () => {
	const recorder = new GifRecorder() as unknown as Internals;
	recorder.frames = [
		{ data: "a", at: 0, viewportWidth: 1280 },
		{ data: "b", at: 500, viewportWidth: 375 },
	];
	recorder.actions = [];
	assert.deepEqual(
		recorder.timeline().map((f) => f.viewportWidth),
		[1280, 375],
	);
});
