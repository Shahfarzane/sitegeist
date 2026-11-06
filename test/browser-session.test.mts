// The session table is shared by every panel and the service worker, each with its own copy of
// this module. These tests run two copies against one fake browser.
// Run: npm test (node --import tsx --test).

import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

type Stored = Record<string, unknown>;
type Tab = { id: number; windowId: number; groupId: number; url: string; active: boolean; pinned: boolean };

// Node 22 has no Web Locks. Serialized per name, which is all the code under test relies on.
if (!("locks" in navigator)) {
	const queues = new Map<string, Promise<unknown>>();
	Object.defineProperty(navigator, "locks", {
		value: {
			request: <T,>(name: string, callback: () => Promise<T>) => {
				const run = (queues.get(name) ?? Promise.resolve()).then(callback, callback);
				queues.set(
					name,
					run.catch(() => undefined),
				);
				return run;
			},
		},
	});
}

const local: Stored = {};
let writes = 0;
const tabs = new Map<number, Tab>();
let nextGroup = 100;
const latency = () => new Promise((r) => setTimeout(r, Math.random() * 3));
const event = () => ({ addListener: () => undefined, removeListener: () => undefined });

(globalThis as Stored).chrome = {
	storage: {
		local: {
			get: async (key: string) => {
				await latency();
				return { [key]: structuredClone(local[key]) };
			},
			set: async (items: Stored) => {
				await latency();
				writes++;
				Object.assign(local, structuredClone(items));
			},
		},
		onChanged: event(),
	},
	tabs: {
		get: async (id: number) => {
			const tab = tabs.get(id);
			if (!tab) throw new Error("No tab");
			return { ...tab };
		},
		query: async (q: { groupId?: number }) => [...tabs.values()].filter((t) => q.groupId === undefined || t.groupId === q.groupId),
		group: async ({ tabIds, groupId }: { tabIds: number[]; groupId?: number }) => {
			const id = groupId ?? nextGroup++;
			for (const t of tabIds) (tabs.get(t) as Tab).groupId = id;
			return id;
		},
		ungroup: async (id: number) => {
			(tabs.get(id) as Tab).groupId = -1;
		},
		onRemoved: event(),
		onActivated: event(),
	},
	tabGroups: { onRemoved: event(), get: async (id: number) => ({ id, windowId: 1 }), update: async () => undefined, query: async () => [] },
	windows: { get: async (id: number) => ({ id, type: "normal" }), getLastFocused: async () => ({ id: 1 }) },
	debugger: { detach: async () => undefined, onDetach: event(), onEvent: event(), getTargets: async () => [] },
	webNavigation: { onCommitted: event() },
};

const load = (context: string) => import(`../src/browser/session.ts?context=${context}`);

beforeEach(() => {
	for (const key of Object.keys(local)) delete local[key];
	tabs.clear();
	writes = 0;
	for (let id = 1; id <= 40; id++) tabs.set(id, { id, windowId: 1, groupId: -1, url: "https://a.test", active: false, pinned: false });
});

test("sessions written at the same time from different contexts all survive", async () => {
	const contexts = await Promise.all(["a", "b", "c", "d"].map((c) => load(c)));
	const sessions = await Promise.all(contexts.map((m, i) => m.BrowserSession.open(`s${i}`, `label ${i}`, 1)));
	await Promise.all(sessions.flatMap((s, i) => [s.adopt(i * 2 + 1), s.adopt(i * 2 + 2)]));
	const table = local.browser_sessions as Record<string, { tabIds: number[] }>;
	assert.deepEqual(Object.keys(table).sort(), ["s0", "s1", "s2", "s3"]);
	sessions.forEach((_s, i) => {
		assert.deepEqual(table[`s${i}`].tabIds.sort(), [i * 2 + 1, i * 2 + 2].sort(), `session ${i}`);
	});
});

test("a tab another context adopted does not come back with a stale write", async () => {
	const [a, b] = await Promise.all([load("e"), load("f")]);
	const first = await a.BrowserSession.open("first", "first", 1);
	const second = await b.BrowserSession.open("second", "second", 1);
	await first.adopt(5);
	await second.adopt(5);
	await first.setLabel("renamed");
	const table = local.browser_sessions as Record<string, { tabIds: number[] }>;
	assert.deepEqual(table.first.tabIds, []);
	assert.deepEqual(table.second.tabIds, [5]);
});

test("using a session does not rewrite the table when nothing changed", async () => {
	const module = await load("g");
	const session = await module.BrowserSession.open("quiet", "quiet", 1);
	await session.adopt(7);
	const before = writes;
	for (let i = 0; i < 20; i++) await session.setCurrent(7);
	assert.equal(writes, before);
});
