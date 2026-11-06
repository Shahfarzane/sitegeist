// CoalescedTask: session saves must never overlap, and the newest state must always land.
// Run: npm test (node --import tsx --test).

import assert from "node:assert/strict";
import { test } from "node:test";
import { CoalescedTask } from "../src/storage/coalesced-task.ts";

const tick = () => new Promise((r) => setTimeout(r, 1));

test("a burst of requests runs the task twice at most", async () => {
	let runs = 0;
	let active = 0;
	let peak = 0;
	const task = new CoalescedTask(async () => {
		runs++;
		active++;
		peak = Math.max(peak, active);
		await tick();
		active--;
	});
	await Promise.all(Array.from({ length: 500 }, () => task.request()));
	assert.equal(peak, 1);
	assert.equal(runs, 2);
});

test("a request during a run sees the state as of that request", async () => {
	let state = 0;
	const seen: number[] = [];
	const task = new CoalescedTask(async () => {
		seen.push(state);
		await tick();
	});
	const first = task.request();
	state = 1;
	task.request();
	state = 2;
	await first;
	assert.equal(seen.at(-1), 2);
});

test("a request queued behind a failing run still gets its run", async () => {
	let runs = 0;
	const task = new CoalescedTask(async () => {
		runs++;
		await tick();
		if (runs === 1) throw new Error("first failed");
	});
	const first = task.request();
	task.request();
	await first;
	assert.equal(runs, 2);
});

test("a failing run rejects its waiters and the next request starts fresh", async () => {
	let fail = true;
	let runs = 0;
	const task = new CoalescedTask(async () => {
		runs++;
		if (fail) throw new Error("disk full");
	});
	await assert.rejects(task.request(), /disk full/);
	fail = false;
	await task.request();
	assert.equal(runs, 2);
});
