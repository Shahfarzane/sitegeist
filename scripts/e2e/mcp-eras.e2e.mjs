// `sitegeist mcp` for clients of both protocol eras on the real path: the same tools and
// instructions, and the "ask" mode site prompt as an elicitation (2025) or input_required (2026).
// Run: SITEGEIST_VERSION=9.9.9 node scripts/build.mjs && (cd cli && npm run build) && npm run test:e2e

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { Browser, bridgeReady, Harness, startFakeServer } from "./lib.mjs";

let browser;
let server;
let worker;

before(async () => {
	server = await startFakeServer({
		routes: { "/asked": "<!doctype html><title>Asked</title><h1>Asked</h1>" },
		script: () => ({ text: "unused" }),
	});
	browser = await Browser.launch({ bridge: true });
	worker = await browser.worker();
	await bridgeReady(browser);
});

after(async () => {
	await browser?.close();
	await server?.close();
});

const asked = () => `${server.origin}/asked`;
const allowedHosts = () =>
	worker.evaluate(`chrome.storage.local.get("bridge_allowed_hosts").then((d) => d.bridge_allowed_hosts ?? [])`);
const askMode = () =>
	worker.evaluate(
		`chrome.storage.local.set({ bridge_full_access_applied: true, bridge_permission_mode: "ask", bridge_allowed_hosts: [] })`,
	);
const fullAccess = () => worker.evaluate(`chrome.storage.local.set({ bridge_permission_mode: "allow_all" })`);

test("a 2026 client gets the same tools and instructions as a 2025 one", async () => {
	const legacy = await Harness.connect(browser, { era: "2025", session: "era-2025" });
	const modern = await Harness.connect(browser, { era: "2026", session: "era-2026" });
	try {
		assert.equal(legacy.client.getProtocolEra(), "legacy");
		assert.equal(modern.client.getProtocolEra(), "modern");
		const tools = await legacy.tools();
		assert.equal(tools.length, 38, tools.join(","));
		assert.deepEqual(await modern.tools(), tools);
		assert.match(legacy.client.getInstructions() ?? "", /drives the user's real Chromium browser/);
		assert.equal(modern.client.getInstructions(), legacy.client.getInstructions());
		await fullAccess();
		assert.equal((await modern.callText("navigate", { url: asked(), read: false })).title, "Asked");
	} finally {
		await legacy.close();
		await modern.close();
	}
});

for (const era of ["2025", "2026"]) {
	test(`${era}: the site prompt reaches the harness and each answer has its effect`, async () => {
		await askMode();
		const questions = [];
		let decision = "allow_once";
		const harness = await Harness.connect(browser, {
			era,
			session: `ask-${era}`,
			elicit: (params) => {
				questions.push(params.message);
				return { action: "accept", content: { decision } };
			},
		});
		try {
			assert.equal((await harness.callText("navigate", { url: asked(), read: false })).title, "Asked");
			assert.deepEqual(await allowedHosts(), [], "allow once stores nothing");
			decision = "deny";
			await assert.rejects(harness.call("navigate", { url: asked() }), /Not allowed to open 127\.0\.0\.1/);
			decision = "allow_host";
			assert.equal((await harness.callText("navigate", { url: asked(), read: false })).title, "Asked");
			assert.deepEqual(await allowedHosts(), ["127.0.0.1"]);
			await harness.callText("navigate", { url: asked(), read: false });
			assert.equal(questions.length, 3, "an allowed host is not asked about again");
			assert.equal(questions[0], "sitegeist: the browser agent wants to open 127.0.0.1. Allow?");
		} finally {
			await harness.close();
			await fullAccess();
		}
	});

	test(`${era}: a client that cannot show the prompt gets the deny text`, async () => {
		await askMode();
		const harness = await Harness.connect(browser, { era, session: `headless-${era}` });
		try {
			await assert.rejects(
				harness.call("navigate", { url: asked() }),
				/Not allowed to open 127\.0\.0\.1\. The user can allow it in the sitegeist side panel under Settings > Bridge/,
			);
		} finally {
			await harness.close();
			await fullAccess();
		}
	});
}

test("SITEGEIST_AUTO_ALLOW=1 allows once without asking", async () => {
	await askMode();
	const harness = await Harness.connect(browser, {
		era: "2026",
		session: "auto-allow",
		env: { SITEGEIST_AUTO_ALLOW: "1" },
		elicit: () => {
			throw new Error("must not ask");
		},
	});
	try {
		assert.equal((await harness.callText("navigate", { url: asked(), read: false })).title, "Asked");
		assert.deepEqual(await allowedHosts(), []);
	} finally {
		await harness.close();
		await fullAccess();
	}
});
