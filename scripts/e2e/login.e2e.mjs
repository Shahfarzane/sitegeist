// 1Password sign-in with a stub `op`: the fill works step by step, and the values stay out of
// every tool result and of the stored chat.
// Run: SITEGEIST_VERSION=9.9.9 node scripts/build.mjs && (cd cli && npm run build) && npm run test:e2e

import assert from "node:assert/strict";
import { chmodSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { Browser, bridgeReady, Harness, openPanel, repoRoot, sendPrompt, startFakeServer } from "./lib.mjs";

const SECRET = "s3cret-test-value";

const loginPage = `<!doctype html><title>Sign in</title><form>
	<label>Email <input id="u" type="email" autocomplete="username"></label>
	<label>Password <input id="p" type="password" autocomplete="current-password"></label>
	<button>Sign in</button></form>`;
const usernameStep = `<!doctype html><title>Step one</title><input id="u" name="identifier"><button>Next</button>`;
const codeStep = `<!doctype html><title>Code</title><label>Code <input id="c" autocomplete="one-time-code"></label>`;
/** Sends the tab to another origin while 1Password waits for the user. */
const redirecting = (target) => `<!doctype html><title>Redirecting</title>
	<input id="p" type="password"><script>setTimeout(() => { location.href = ${JSON.stringify(target)}; }, 500);</script>`;

let browser;
let server;
let harness;
let turns;

before(async () => {
	server = await startFakeServer({
		routes: {
			"/login": loginPage,
			"/step": usernameStep,
			"/code": codeStep,
			"/redirecting": () => redirecting(`http://localhost:${server.port}/login`),
		},
		script: (body, index) => turns(body, index),
	});
	const op = join(repoRoot, "scripts/e2e/fake-op.mjs");
	chmodSync(op, 0o755);
	browser = await Browser.launch({
		bridge: true,
		env: { SITEGEIST_OP_PATH: op, SITEGEIST_E2E_LOGIN_PORT: String(server.port) },
	});
	await browser.worker();
	await bridgeReady(browser);
	harness = await Harness.connect(browser);
});

after(async () => {
	await harness.close();
	await browser.close();
	await server.close();
});

const value = async (selector) =>
	(await harness.callText("run_js", { code: `document.querySelector(${JSON.stringify(selector)}).value` })).value;

test("fill_login fills the form and tells the agent nothing secret", async () => {
	await harness.callText("navigate", { url: `${server.origin}/login` });
	const result = await harness.call("fill_login", {});
	const text = JSON.stringify(result);
	assert.ok(!text.includes(SECRET), text);
	assert.deepEqual(JSON.parse(result.content[0].text), { filled: ["username", "password"], item: "Fixture login" });
	assert.equal(await value("#u"), "ada@example.test");
	assert.equal(await value("#p"), SECRET);
	const page = JSON.stringify(await harness.call("read_page", {}));
	assert.ok(!page.includes(SECRET), "read_page must not show the password");
});

test("a site with no saved login says so", async () => {
	await harness.callText("navigate", { url: "about:blank" }).catch(() => undefined);
	await harness.callText("navigate", { url: `http://localhost:${server.port}/login` });
	await assert.rejects(harness.call("fill_login", {}), /No 1Password login is saved for localhost/);
	assert.equal(await value("#p"), "");
});

test("an item from another site is refused, even when asked for by id", async () => {
	await harness.callText("navigate", { url: `${server.origin}/login` });
	await assert.rejects(harness.call("fill_login", { item: "other" }), /not saved for this site/);
	assert.equal(await value("#p"), "");
});

test("a redirect during the 1Password prompt does not get the password", async () => {
	await harness.callText("navigate", { url: `${server.origin}/redirecting` });
	await assert.rejects(harness.call("fill_login", { item: "slow" }), /page changed while waiting/);
	const landed = await harness.callText("run_js", { code: "location.host" });
	assert.equal(landed.value, `localhost:${server.port}`);
	assert.equal(await value("#p"), "");
});

test("multi-step sign-in: username first, then a one-time code", async () => {
	await harness.callText("navigate", { url: `${server.origin}/step` });
	const step = await harness.callText("fill_login", {});
	assert.deepEqual(step.filled, ["username"]);
	assert.equal(await value("#u"), "ada@example.test");
	await harness.callText("navigate", { url: `${server.origin}/code` });
	const code = await harness.callText("fill_login", {});
	assert.deepEqual(code.filled, ["otp"]);
	assert.equal(await value("#c"), "424242");
});

test("the panel agent signs in and the secret stays out of the chat and the request", async () => {
	turns = (_body, index) => (index === 0 ? { toolCalls: [{ name: "fill_login", args: {} }] } : { text: "signed in" });
	server.requests.length = 0;
	const context = await openPanel(browser, server, { path: "/login" });
	await sendPrompt(context.panel, "log me in");
	await context.panel.waitFor(`document.body.innerText.includes("signed in")`, { timeoutMs: 15000 });
	await context.tab.waitFor(`document.querySelector("#p").value === ${JSON.stringify(SECRET)}`);
	assert.ok(!JSON.stringify(server.requests).includes(SECRET), "the model request must not carry the password");
	assert.ok(JSON.stringify(server.requests[1].messages).includes("Filled username and password"));
	const stored = await context.panel.evaluate(
		`new Promise((res) => { const r = indexedDB.open("sitegeist-storage"); r.onsuccess = () => { const q = r.result.transaction("sessions").objectStore("sessions").getAll(); q.onsuccess = () => { r.result.close(); res(JSON.stringify(q.result)); }; }; })`,
	);
	assert.ok(stored.length > 100 && !stored.includes(SECRET), "the stored chat must not carry the password");
	assert.ok(!(await context.panel.evaluate(`document.body.innerText`)).includes(SECRET));
	await context.panel.close();
	await context.tab.close();
});
