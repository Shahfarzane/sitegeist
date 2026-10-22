/**
 * Borrow the coding CLIs' logins on this computer, so the Claude and ChatGPT providers
 * work without a sitegeist login: Claude Code's for Anthropic, Codex's for ChatGPT.
 *
 * The native host reads them (cli/src/credentials.ts) and hands out the access token
 * only. A borrowed login is stored like any OAuth login, marked `source: "cli"`; when its
 * token expires, resolveApiKey asks the host again instead of refreshing it here, because
 * a refresh here would rotate the CLI's refresh token and log the CLI out.
 *
 * Claude Code's login is read only, so it lapses 8 hours after the claude CLI last ran. A
 * borrowed Claude login therefore keeps sitegeist's own Claude login, if the user has one,
 * as `fallback`, and resolveApiKey uses that while Claude Code's has expired.
 */

import {
	type CliLoginProvider,
	type ExtCredentialsRequest,
	type HostCredentialsResponse,
	NATIVE_HOST_NAME,
} from "../bridge/protocol.js";
import {
	isOAuthCredentials,
	type OAuthCredentials,
	parseOAuthCredentials,
	serializeOAuthCredentials,
} from "./types.js";

export const CLI_LOGIN_PROVIDERS: CliLoginProvider[] = ["anthropic", "openai-codex"];

/** Providers whose borrowed login keeps sitegeist's own login as its fallback. */
const FALLBACK_PROVIDERS: CliLoginProvider[] = ["anthropic"];

const CLI_NAMES: Record<CliLoginProvider, string> = { anthropic: "Claude Code", "openai-codex": "Codex" };

/** Providers the user disconnected; startup does not borrow these again until they log in. */
const OFF_KEY = "cli_login_off";

/** A refresh of Codex's login goes over the network; an old host never answers at all. */
const LOOKUP_TIMEOUT_MS = 20_000;
/**
 * A borrowed token that has not expired is still compared with the CLI's this often: it
 * changes when the CLI refreshes early or switches account. Quick, since it is optional.
 */
const RECHECK_MS = 5 * 60 * 1000;
const RECHECK_TIMEOUT_MS = 3000;
const lastCheck = new Map<CliLoginProvider, number>();
/** When an expired borrowed login last could not be read again. */
const lastFailure = new Map<CliLoginProvider, number>();

interface KeyStore {
	get(provider: string): Promise<string | null>;
	set(provider: string, value: string): Promise<void>;
}

export function isCliLoginProvider(provider: string): provider is CliLoginProvider {
	return (CLI_LOGIN_PROVIDERS as string[]).includes(provider);
}

export function cliName(provider: CliLoginProvider): string {
	return CLI_NAMES[provider];
}

export function keepsFallback(provider: string): boolean {
	return (FALLBACK_PROVIDERS as string[]).includes(provider);
}

/** sitegeist's own OAuth login in a stored value: the value itself, or a borrowed login's fallback. */
export function ownLogin(stored: string | null): OAuthCredentials | undefined {
	if (!stored || !isOAuthCredentials(stored)) return undefined;
	const credentials = parseOAuthCredentials(stored);
	return credentials.source === "cli" ? credentials.fallback : credentials;
}

/** The borrowed login in a stored value, without its fallback. */
export function borrowedLogin(stored: string | null): OAuthCredentials | undefined {
	if (!stored || !isOAuthCredentials(stored)) return undefined;
	const { fallback: _, ...credentials } = parseOAuthCredentials(stored);
	return credentials.source === "cli" ? credentials : undefined;
}

/** The value to store: the borrowed login in front, carrying the own login where the provider keeps one. */
export function combineLogins(
	provider: string,
	borrowed: OAuthCredentials | undefined,
	own: OAuthCredentials | undefined,
): OAuthCredentials | undefined {
	if (!borrowed) return own;
	return own && keepsFallback(provider) ? { ...borrowed, fallback: own } : borrowed;
}

export async function isCliLoginOff(provider: CliLoginProvider): Promise<boolean> {
	const data = await chrome.storage.local.get(OFF_KEY);
	return ((data[OFF_KEY] as string[] | undefined) ?? []).includes(provider);
}

export async function setCliLoginOff(provider: CliLoginProvider, off: boolean): Promise<void> {
	const data = await chrome.storage.local.get(OFF_KEY);
	const current = ((data[OFF_KEY] as string[] | undefined) ?? []).filter((p) => p !== provider);
	await chrome.storage.local.set({ [OFF_KEY]: off ? [...current, provider] : current });
}

/** The CLI's current login for a provider. Throws with the reason there is none. */
export async function readCliLogin(
	provider: CliLoginProvider,
	timeoutMs = LOOKUP_TIMEOUT_MS,
): Promise<OAuthCredentials> {
	const request: ExtCredentialsRequest = { type: "credentials", provider };
	const outdated = `Cannot read the ${CLI_NAMES[provider]} login: the sitegeist CLI is outdated (rebuild it: cd cli && npm run build)`;
	let response: HostCredentialsResponse | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		response = await Promise.race([
			chrome.runtime.sendNativeMessage(NATIVE_HOST_NAME, request) as Promise<HostCredentialsResponse>,
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error("timeout")), timeoutMs);
			}),
		]);
	} catch (err) {
		const reason = err instanceof Error ? err.message : String(err);
		// "Specified native messaging host not found." until `sitegeist install` has run.
		if (/not found/i.test(reason)) {
			throw new Error(
				`Cannot read the ${CLI_NAMES[provider]} login: the sitegeist CLI is not installed (sitegeist install)`,
			);
		}
		throw new Error(
			reason === "timeout" ? `${outdated}, or it is still waiting on a token refresh` : `${outdated}: ${reason}`,
		);
	} finally {
		clearTimeout(timer);
	}
	// An old host relays a harness frame here instead of answering.
	if (response?.type !== "credentials") throw new Error(outdated);
	const credentials = response.credentials;
	if (!credentials) throw new Error(response.error ?? `No ${CLI_NAMES[provider]} login found`);
	return {
		providerId: provider,
		access: credentials.access,
		refresh: "",
		expires: credentials.expires,
		accountId: credentials.accountId,
		source: "cli",
	};
}

/**
 * The token for a borrowed login: the stored one, read again from the CLI when it expires
 * and every RECHECK_MS otherwise. Throws only when the stored token has expired. With a
 * fallback to use meanwhile, a lapsed CLI login is asked for once per RECHECK_MS, briefly.
 */
export async function currentCliLogin(
	provider: CliLoginProvider,
	stored: OAuthCredentials,
	options: { fallback?: boolean } = {},
): Promise<OAuthCredentials> {
	const expired = Date.now() >= stored.expires - 60_000;
	if (!expired && Date.now() - (lastCheck.get(provider) ?? 0) < RECHECK_MS) return stored;
	if (expired && options.fallback && Date.now() - (lastFailure.get(provider) ?? 0) < RECHECK_MS) {
		throw new Error(`The ${CLI_NAMES[provider]} login has expired`);
	}
	lastCheck.set(provider, Date.now());
	try {
		return await readCliLogin(provider, expired && !options.fallback ? LOOKUP_TIMEOUT_MS : RECHECK_TIMEOUT_MS);
	} catch (err) {
		// The CLI logged out or is slow; a token that has not expired still works.
		if (!expired) return stored;
		lastFailure.set(provider, Date.now());
		throw err;
	}
}

/** Store the CLI's login for a provider, unless the user disconnected it. True when stored. */
export async function borrowCliLogin(store: KeyStore, provider: string): Promise<boolean> {
	if (!isCliLoginProvider(provider) || (await isCliLoginOff(provider))) return false;
	try {
		const credentials = await readCliLogin(provider);
		// Logout may have happened while the lookup ran.
		if (await isCliLoginOff(provider)) return false;
		const combined = combineLogins(provider, credentials, ownLogin(await store.get(provider)));
		if (combined) await store.set(provider, serializeOAuthCredentials(combined));
		// Just read: the next request need not ask again. (Only a read that is stored counts, so a
		// probe from Settings cannot hold back a newer token.)
		lastCheck.set(provider, Date.now());
		return true;
	} catch (err) {
		console.info(`[cli-login] ${provider}: ${err instanceof Error ? err.message : String(err)}`);
		return false;
	}
}

/**
 * Borrow every CLI login whose provider has no key yet. For Claude, Claude Code's login also
 * goes in front of a sitegeist login, which stays as its fallback.
 */
export async function borrowCliLogins(store: KeyStore): Promise<void> {
	await Promise.all(
		CLI_LOGIN_PROVIDERS.map(async (provider) => {
			const stored = await store.get(provider);
			const ownOnly = keepsFallback(provider) && !!ownLogin(stored) && !borrowedLogin(stored);
			if (!stored || ownOnly) await borrowCliLogin(store, provider);
		}),
	);
}
