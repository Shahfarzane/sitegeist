/**
 * The coding CLIs' own logins, so the extension's Claude and ChatGPT providers need no
 * login of their own: Claude Code's OAuth token (macOS Keychain item "Claude
 * Code-credentials", or ~/.claude/.credentials.json) and Codex's ChatGPT login
 * ($CODEX_HOME/auth.json, default ~/.codex). Only access tokens leave this process.
 *
 * Claude Code's login is read only: when its access token has expired, Claude Code
 * refreshes it the next time it runs.
 *
 * Codex's login is refreshed here when it is about to expire, and the result is written
 * back to auth.json. Refresh tokens rotate, so a refresh that is not saved would leave
 * Codex holding a dead one.
 */

import { execFile } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CliCredentials, HostCredentialsResponse } from "../../src/bridge/protocol.ts";

/** Tokens with less time left count as expired. */
const MIN_REMAINING_MS = 2 * 60 * 1000;
const KEYCHAIN_SERVICE = "Claude Code-credentials";
const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const CODEX_TOKEN_URL = "https://auth.openai.com/oauth/token";
const CODEX_JWT_CLAIM = "https://api.openai.com/auth";
const LOCK_WAIT_MS = 20_000;
/** A lock older than this was left by a host that died mid-refresh. */
const LOCK_STALE_MS = 30_000;

export interface LookupOptions {
	/** Reads a generic password from the login keychain; undefined when there is none. */
	keychain?: (service: string) => Promise<string | undefined>;
	codexTokenUrl?: string;
}

export async function cliCredentials(provider: string, options: LookupOptions = {}): Promise<HostCredentialsResponse> {
	try {
		if (provider === "anthropic") {
			return { type: "credentials", credentials: await readClaudeCode(options.keychain ?? keychainSecret) };
		}
		if (provider === "openai-codex") {
			return { type: "credentials", credentials: await readCodex(options.codexTokenUrl ?? CODEX_TOKEN_URL) };
		}
		return { type: "credentials", error: `No coding CLI logs in ${provider}` };
	} catch (err) {
		return { type: "credentials", error: err instanceof Error ? err.message : String(err) };
	}
}

const usable = (c: CliCredentials) => c.expires - Date.now() >= MIN_REMAINING_MS;

// ---- Claude Code --------------------------------------------------------------

function keychainSecret(service: string): Promise<string | undefined> {
	if (process.platform !== "darwin") return Promise.resolve(undefined);
	return new Promise((resolve) => {
		execFile("/usr/bin/security", ["find-generic-password", "-s", service, "-w"], { timeout: 10_000 }, (err, stdout) =>
			resolve(err ? undefined : stdout.trim()),
		);
	});
}

async function readClaudeCode(keychain: (service: string) => Promise<string | undefined>): Promise<CliCredentials> {
	const file = join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), ".credentials.json");
	const raw = (await keychain(KEYCHAIN_SERVICE)) ?? (existsSync(file) ? readFileSync(file, "utf8") : undefined);
	if (!raw) throw new Error("Claude Code is not logged in on this computer");
	const oauth = (JSON.parse(raw) as { claudeAiOauth?: { accessToken?: string; expiresAt?: number } }).claudeAiOauth;
	if (!oauth?.accessToken) throw new Error("Claude Code is not logged in with a Claude subscription");
	const credentials = { access: oauth.accessToken, expires: oauth.expiresAt ?? 0, source: "Claude Code" };
	if (!usable(credentials)) {
		throw new Error("Claude Code's login has expired. Run claude once, then sitegeist picks up the refreshed login.");
	}
	return credentials;
}

// ---- Codex --------------------------------------------------------------------

interface CodexAuth {
	OPENAI_API_KEY?: string | null;
	tokens?: { id_token?: string; access_token?: string; refresh_token?: string; account_id?: string };
	last_refresh?: string;
	[key: string]: unknown;
}

function codexAuthPath(): string {
	return join(process.env.CODEX_HOME || join(homedir(), ".codex"), "auth.json");
}

function readCodexAuth(path: string): CodexAuth {
	if (!existsSync(path)) throw new Error("Codex is not logged in on this computer");
	return JSON.parse(readFileSync(path, "utf8")) as CodexAuth;
}

function jwtClaims(token: string): Record<string, unknown> | undefined {
	try {
		return JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"));
	} catch {
		return undefined;
	}
}

function codexCredentials(auth: CodexAuth): CliCredentials | undefined {
	const access = auth.tokens?.access_token;
	if (!access) return undefined;
	const claims = jwtClaims(access);
	const exp = typeof claims?.exp === "number" ? claims.exp * 1000 : 0;
	const accountId =
		(claims?.[CODEX_JWT_CLAIM] as { chatgpt_account_id?: string } | undefined)?.chatgpt_account_id ??
		auth.tokens?.account_id;
	return { access, expires: exp, accountId, source: "Codex" };
}

async function readCodex(tokenUrl: string): Promise<CliCredentials> {
	const path = codexAuthPath();
	const initial = readCodexAuth(path);
	if (!initial.tokens?.refresh_token) throw new Error("Codex is logged in with an API key, not with ChatGPT");
	const current = codexCredentials(initial);
	if (current && usable(current)) return current;

	return withLock(`${path}.sitegeist-lock`, async () => {
		// Another host or Codex itself may have refreshed while this one waited.
		const auth = readCodexAuth(path);
		const latest = codexCredentials(auth);
		if (latest && usable(latest)) return latest;
		const used = auth.tokens?.refresh_token ?? "";
		let tokens: { id_token?: string; access_token?: string; refresh_token?: string };
		try {
			tokens = await refreshCodexTokens(tokenUrl, used);
		} catch (err) {
			const after = readCodexAuth(path);
			const theirs = codexCredentials(after);
			if (after.tokens?.refresh_token !== used && theirs && usable(theirs)) return theirs;
			throw new Error(
				`Codex's login could not be refreshed (${err instanceof Error ? err.message : String(err)}). Run codex login.`,
			);
		}
		const updated: CodexAuth = {
			...auth,
			tokens: { ...auth.tokens, ...tokens },
			last_refresh: new Date().toISOString(),
		};
		writeAtomic(path, `${JSON.stringify(updated, null, 2)}\n`);
		const refreshed = codexCredentials(updated);
		if (!refreshed || !usable(refreshed)) throw new Error("Codex's refreshed token is already expired");
		return refreshed;
	});
}

/** The same request Codex makes; the response carries a new refresh token. */
async function refreshCodexTokens(
	tokenUrl: string,
	refreshToken: string,
): Promise<{ id_token?: string; access_token?: string; refresh_token?: string }> {
	const response = await fetch(tokenUrl, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			client_id: CODEX_CLIENT_ID,
			grant_type: "refresh_token",
			refresh_token: refreshToken,
			scope: "openid profile email",
		}),
		signal: AbortSignal.timeout(15_000),
	});
	if (!response.ok) throw new Error(`token endpoint returned ${response.status}`);
	const data = (await response.json()) as Record<string, unknown>;
	if (typeof data.access_token !== "string") throw new Error("token response has no access_token");
	const tokens: { id_token?: string; access_token?: string; refresh_token?: string } = {
		access_token: data.access_token,
	};
	if (typeof data.id_token === "string") tokens.id_token = data.id_token;
	if (typeof data.refresh_token === "string") tokens.refresh_token = data.refresh_token;
	return tokens;
}

function writeAtomic(path: string, content: string): void {
	const tmp = `${path}.sitegeist-${process.pid}`;
	writeFileSync(tmp, content, { mode: 0o600 });
	renameSync(tmp, path);
}

/**
 * One refresh at a time across host processes: every side panel can ask at once, and two
 * refreshes with the same refresh token make the second one fail (or revoke the login).
 */
async function withLock<T>(lock: string, fn: () => Promise<T>): Promise<T> {
	const deadline = Date.now() + LOCK_WAIT_MS;
	for (;;) {
		try {
			closeSync(openSync(lock, "wx", 0o600));
			break;
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
			const held = statSync(lock, { throwIfNoEntry: false });
			if (held && Date.now() - held.mtimeMs > LOCK_STALE_MS) rmSync(lock, { force: true });
			else if (Date.now() > deadline) throw new Error("Timed out waiting for another refresh of the Codex login");
			else await new Promise((resolve) => setTimeout(resolve, 100));
		}
	}
	try {
		return await fn();
	} finally {
		rmSync(lock, { force: true });
	}
}
