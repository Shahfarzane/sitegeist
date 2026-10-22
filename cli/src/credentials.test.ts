import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import type { HostCredentialsResponse } from "../../src/bridge/protocol.ts";
import { cliCredentials } from "./credentials.ts";
import { encodeFrame, FrameParser } from "./framing.ts";
import { socketPath } from "./paths.ts";

const HOUR = 3600;
const ACCOUNT = "acct-123";

function jwt(expSeconds: number, account = ACCOUNT): string {
	const part = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
	return `${part({ alg: "none" })}.${part({ exp: expSeconds, "https://api.openai.com/auth": { chatgpt_account_id: account } })}.sig`;
}

const now = () => Math.floor(Date.now() / 1000);

let home: string;
let authPath: string;
let server: Server | undefined;

function writeAuth(accessExp: number, refresh = "refresh-1"): void {
	writeFileSync(
		authPath,
		JSON.stringify(
			{
				auth_mode: "chatgpt",
				OPENAI_API_KEY: null,
				tokens: { id_token: "id-1", access_token: jwt(accessExp), refresh_token: refresh, account_id: ACCOUNT },
				last_refresh: "2026-01-01T00:00:00Z",
				extra_field: { kept: true },
			},
			null,
			2,
		),
		{ mode: 0o600 },
	);
}

const readAuth = () => JSON.parse(readFileSync(authPath, "utf8"));

/** A token endpoint that records request bodies and answers with `respond`. */
async function tokenEndpoint(respond: (body: Record<string, string>) => { status: number; json: object }) {
	const bodies: Array<Record<string, string>> = [];
	server = createServer(async (req: IncomingMessage, res) => {
		let raw = "";
		for await (const chunk of req) raw += chunk;
		const body = JSON.parse(raw);
		bodies.push(body);
		const { status, json } = respond(body);
		res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(json));
	});
	await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as AddressInfo;
	return { url: `http://127.0.0.1:${port}/oauth/token`, bodies };
}

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "sitegeist-cred-"));
	authPath = join(home, "auth.json");
	process.env.CODEX_HOME = home;
	process.env.CLAUDE_CONFIG_DIR = home;
});

afterEach(async () => {
	await new Promise((resolve) => (server ? server.close(resolve) : resolve(undefined)));
	server = undefined;
});

const noKeychain = async () => undefined;

test("codex: a valid token is returned as is, without a refresh", async () => {
	writeAuth(now() + 48 * HOUR);
	const before = readFileSync(authPath, "utf8");
	const response = await cliCredentials("openai-codex", { codexTokenUrl: "http://127.0.0.1:9/unused" });
	assert.equal(response.error, undefined);
	assert.equal(response.credentials?.accountId, ACCOUNT);
	assert.equal(response.credentials?.source, "Codex");
	assert.equal(response.credentials?.expires, (now() + 48 * HOUR) * 1000);
	assert.equal(readFileSync(authPath, "utf8"), before);
});

test("codex: an expired token is refreshed and written back with every other field kept", async () => {
	writeAuth(now() - HOUR);
	const fresh = jwt(now() + 240 * HOUR);
	const endpoint = await tokenEndpoint(() => ({
		status: 200,
		json: { access_token: fresh, refresh_token: "refresh-2", id_token: "id-2" },
	}));
	const response = await cliCredentials("openai-codex", { codexTokenUrl: endpoint.url });
	assert.equal(response.error, undefined);
	assert.equal(response.credentials?.access, fresh);
	assert.deepEqual(endpoint.bodies, [
		{
			client_id: "app_EMoamEEZ73f0CkXaXp7hrann",
			grant_type: "refresh_token",
			refresh_token: "refresh-1",
			scope: "openid profile email",
		},
	]);
	const saved = readAuth();
	assert.deepEqual(saved.tokens, { id_token: "id-2", access_token: fresh, refresh_token: "refresh-2", account_id: ACCOUNT });
	assert.equal(saved.auth_mode, "chatgpt");
	assert.equal(saved.OPENAI_API_KEY, null);
	assert.deepEqual(saved.extra_field, { kept: true });
	assert.notEqual(saved.last_refresh, "2026-01-01T00:00:00Z");
	assert.equal(statSync(authPath).mode & 0o777, 0o600);
	assert.equal(existsSync(`${authPath}.sitegeist-lock`), false);
});

test("codex: concurrent lookups refresh once", async () => {
	writeAuth(now() - HOUR);
	const fresh = jwt(now() + 240 * HOUR);
	const endpoint = await tokenEndpoint(() => ({ status: 200, json: { access_token: fresh, refresh_token: "refresh-2" } }));
	const results = await Promise.all(
		[1, 2, 3].map(() => cliCredentials("openai-codex", { codexTokenUrl: endpoint.url })),
	);
	assert.equal(endpoint.bodies.length, 1);
	for (const r of results) assert.equal(r.credentials?.access, fresh);
});

test("codex: a failed refresh leaves auth.json alone and says how to fix it", async () => {
	writeAuth(now() - HOUR);
	const before = readFileSync(authPath, "utf8");
	const endpoint = await tokenEndpoint(() => ({ status: 400, json: { error: "refresh_token_reused" } }));
	const response = await cliCredentials("openai-codex", { codexTokenUrl: endpoint.url });
	assert.equal(response.credentials, undefined);
	assert.match(response.error ?? "", /codex login/);
	assert.equal(readFileSync(authPath, "utf8"), before);
});

test("codex: when Codex rotated the token during a failed refresh, its new token is used", async () => {
	writeAuth(now() - HOUR);
	const theirs = now() + 100 * HOUR;
	const endpoint = await tokenEndpoint(() => {
		writeAuth(theirs, "refresh-from-codex");
		return { status: 400, json: { error: "refresh_token_reused" } };
	});
	const response = await cliCredentials("openai-codex", { codexTokenUrl: endpoint.url });
	assert.equal(response.error, undefined);
	assert.equal(response.credentials?.expires, theirs * 1000);
	assert.equal(readAuth().tokens.refresh_token, "refresh-from-codex");
});

test("codex: when Codex logs in again during a refresh, its auth.json is kept", async () => {
	writeAuth(now() - HOUR);
	const theirs = now() + 200 * HOUR;
	const endpoint = await tokenEndpoint(() => {
		writeAuth(theirs, "refresh-new-login");
		return { status: 200, json: { access_token: jwt(now() + 240 * HOUR), refresh_token: "refresh-2" } };
	});
	const response = await cliCredentials("openai-codex", { codexTokenUrl: endpoint.url });
	assert.equal(response.credentials?.expires, theirs * 1000);
	assert.equal(readAuth().tokens.refresh_token, "refresh-new-login");
});

test("codex: a lock left by a dead host is broken at once", async () => {
	writeAuth(now() - HOUR);
	const dead = spawn(process.execPath, ["-e", ""]);
	await new Promise((resolve) => dead.on("exit", resolve));
	writeFileSync(`${authPath}.sitegeist-lock`, String(dead.pid));
	const endpoint = await tokenEndpoint(() => ({ status: 200, json: { access_token: jwt(now() + 240 * HOUR) } }));
	const started = Date.now();
	const response = await cliCredentials("openai-codex", { codexTokenUrl: endpoint.url });
	assert.equal(response.error, undefined);
	assert.ok(Date.now() - started < 1000, "waited on a dead holder");
	assert.equal(existsSync(`${authPath}.sitegeist-lock`), false);
});

test("codex: a symlinked auth.json stays a link and its target gets the refresh", async () => {
	const real = join(home, "real");
	mkdirSync(real);
	const target = join(real, "auth.json");
	writeAuth(now() - HOUR);
	writeFileSync(target, readFileSync(authPath));
	const linkDir = join(home, "linked");
	mkdirSync(linkDir);
	symlinkSync(target, join(linkDir, "auth.json"));
	process.env.CODEX_HOME = linkDir;
	const fresh = jwt(now() + 240 * HOUR);
	const endpoint = await tokenEndpoint(() => ({ status: 200, json: { access_token: fresh, refresh_token: "refresh-2" } }));
	const response = await cliCredentials("openai-codex", { codexTokenUrl: endpoint.url });
	assert.equal(response.credentials?.access, fresh);
	assert.ok(lstatSync(join(linkDir, "auth.json")).isSymbolicLink());
	assert.equal(JSON.parse(readFileSync(target, "utf8")).tokens.refresh_token, "refresh-2");
});

test("codex: missing login and API-key login are reported", async () => {
	assert.match((await cliCredentials("openai-codex")).error ?? "", /not logged in/);
	writeFileSync(authPath, JSON.stringify({ OPENAI_API_KEY: "sk-test", tokens: null }));
	assert.match((await cliCredentials("openai-codex")).error ?? "", /API key/);
});

test("claude code: the keychain entry is read and never refreshed", async () => {
	const expiresAt = Date.now() + 4 * HOUR * 1000;
	const keychain = async (service: string) =>
		service === "Claude Code-credentials"
			? JSON.stringify({ claudeAiOauth: { accessToken: "sk-ant-oat01-test", refreshToken: "r", expiresAt } })
			: undefined;
	const response = await cliCredentials("anthropic", { keychain });
	assert.deepEqual(response.credentials, { access: "sk-ant-oat01-test", expires: expiresAt, source: "Claude Code" });

	const expired = async () =>
		JSON.stringify({ claudeAiOauth: { accessToken: "sk-ant-oat01-old", refreshToken: "r", expiresAt: Date.now() - 1000 } });
	assert.match((await cliCredentials("anthropic", { keychain: expired })).error ?? "", /Run claude once/);
});

test("claude code: falls back to .credentials.json without a keychain entry", async () => {
	assert.match((await cliCredentials("anthropic", { keychain: noKeychain })).error ?? "", /not logged in/);
	const expiresAt = Date.now() + HOUR * 1000;
	writeFileSync(join(home, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "sk-ant-oat01-file", expiresAt } }));
	const response = await cliCredentials("anthropic", { keychain: noKeychain });
	assert.equal(response.credentials?.access, "sk-ant-oat01-file");
});

test("host: a credentials frame is answered without opening the bridge socket", async () => {
	writeAuth(now() + 48 * HOUR);
	const index = join(dirname(fileURLToPath(import.meta.url)), "index.ts");
	const child = spawn(process.execPath, ["--experimental-transform-types", "--no-warnings", index, "host"], { env: { ...process.env, CODEX_HOME: home } });
	const parser = new FrameParser(1024 * 1024);
	const reply = new Promise<HostCredentialsResponse>((resolve) => {
		child.stdout.on("data", (chunk: Buffer) => {
			const [first] = parser.push(chunk);
			if (first) resolve(first as HostCredentialsResponse);
		});
	});
	child.stdin.write(encodeFrame({ type: "credentials", provider: "openai-codex" }));
	const response = await reply;
	assert.equal(response.credentials?.accountId, ACCOUNT);
	assert.equal(existsSync(socketPath(child.pid ?? 0)), false);
	child.stdin.end();
	const code = await new Promise((resolve) => child.on("exit", resolve));
	assert.equal(code, 0);
});
