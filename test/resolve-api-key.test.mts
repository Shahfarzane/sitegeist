// resolveApiKey with a borrowed Claude login whose Claude Code token has expired: the
// fallback (sitegeist's own login) is refreshed and used. A store change while that
// refresh runs must survive it, and the rotated refresh token must follow the same login.
// Run: npm test (node --import tsx --test).

import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { resolveApiKey } from "../src/oauth/index.ts";

type Stored = Record<string, unknown>;

const local: Stored = {};
(globalThis as Stored).chrome = {
	storage: {
		local: {
			get: async (key: string) => ({ [key]: local[key] }),
			set: async (items: Stored) => Object.assign(local, items),
		},
	},
	// The native host answers that Claude Code's login has expired.
	runtime: { sendNativeMessage: async () => ({ type: "credentials", error: "Claude Code's login has expired." }) },
};

let duringRefresh: () => void = () => {};
globalThis.fetch = async () => {
	duringRefresh();
	return new Response(
		JSON.stringify({ access_token: "own-access-2", refresh_token: "own-refresh-2", expires_in: 3600 }),
		{ status: 200 },
	);
};

const own = { providerId: "anthropic", access: "own-access-1", refresh: "own-refresh-1", expires: Date.now() - 1000 };
const borrowed = { providerId: "anthropic", access: "cc-expired", refresh: "", expires: Date.now() - 1000, source: "cli" };
const start = JSON.stringify({ ...borrowed, fallback: own });

let store: Map<string, string>;
const keys = {
	get: async (provider: string) => store.get(provider) ?? null,
	set: async (provider: string, value: string) => void store.set(provider, value),
};

async function resolveWhile(change?: () => void): Promise<{ token: string; after: string }> {
	duringRefresh = change ?? (() => {});
	const token = await resolveApiKey(start, "anthropic", keys);
	return { token, after: store.get("anthropic") ?? "" };
}

beforeEach(() => {
	store = new Map([["anthropic", start]]);
});

test("expired Claude Code login: the refreshed fallback is used and stored in place", async () => {
	const { token, after } = await resolveWhile();
	assert.equal(token, "own-access-2");
	const saved = JSON.parse(after);
	assert.equal(saved.source, "cli");
	assert.equal(saved.fallback.refresh, "own-refresh-2");
});

test("Logout during the refresh: the promoted sitegeist login gets the rotated token", async () => {
	const { after } = await resolveWhile(() => store.set("anthropic", JSON.stringify(own)));
	const saved = JSON.parse(after);
	assert.equal(saved.source, undefined);
	assert.equal(saved.refresh, "own-refresh-2");
});

test("Remove during the refresh: the fallback stays removed", async () => {
	const { after } = await resolveWhile(() => store.set("anthropic", JSON.stringify(borrowed)));
	assert.equal(JSON.parse(after).fallback, undefined);
});

test("an API key saved during the refresh is kept", async () => {
	const { after } = await resolveWhile(() => store.set("anthropic", "sk-ant-api03-test"));
	assert.equal(after, "sk-ant-api03-test");
});

test("a new login during the refresh is kept", async () => {
	const other = JSON.stringify({ ...own, refresh: "other-login" });
	const { after } = await resolveWhile(() => store.set("anthropic", other));
	assert.equal(after, other);
});
