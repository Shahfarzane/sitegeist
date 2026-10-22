/**
 * Borrow the coding CLIs' logins on this computer, so the Claude and ChatGPT providers
 * work without a sitegeist login: Claude Code's for Anthropic, Codex's for ChatGPT.
 *
 * The native host reads them (cli/src/credentials.ts) and hands out the access token
 * only. A borrowed login is stored like any OAuth login, marked `source: "cli"`; when its
 * token expires, resolveApiKey asks the host again instead of refreshing it here, because
 * a refresh here would rotate the CLI's refresh token and log the CLI out.
 */

import {
	type CliLoginProvider,
	type ExtCredentialsRequest,
	type HostCredentialsResponse,
	NATIVE_HOST_NAME,
} from "../bridge/protocol.js";
import { type OAuthCredentials, serializeOAuthCredentials } from "./types.js";

export const CLI_LOGIN_PROVIDERS: CliLoginProvider[] = ["anthropic", "openai-codex"];

const CLI_NAMES: Record<CliLoginProvider, string> = { anthropic: "Claude Code", "openai-codex": "Codex" };

/** Providers the user disconnected; startup does not borrow these again until they log in. */
const OFF_KEY = "cli_login_off";

/** A refresh of Codex's login goes over the network; an old host never answers at all. */
const LOOKUP_TIMEOUT_MS = 20_000;

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
export async function readCliLogin(provider: CliLoginProvider): Promise<OAuthCredentials> {
	const request: ExtCredentialsRequest = { type: "credentials", provider };
	let response: HostCredentialsResponse | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		response = await Promise.race([
			chrome.runtime.sendNativeMessage(NATIVE_HOST_NAME, request) as Promise<HostCredentialsResponse>,
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error("the sitegeist CLI did not answer")), LOOKUP_TIMEOUT_MS);
			}),
		]);
	} catch (err) {
		// "Specified native messaging host not found." until `sitegeist install` has run.
		const reason = err instanceof Error ? err.message : String(err);
		throw new Error(
			`Cannot read the ${CLI_NAMES[provider]} login: ${reason}. Update the sitegeist CLI and run "sitegeist install".`,
		);
	} finally {
		clearTimeout(timer);
	}
	const credentials = response?.credentials;
	if (!credentials) throw new Error(response?.error ?? `No ${CLI_NAMES[provider]} login found`);
	return {
		providerId: provider,
		access: credentials.access,
		refresh: "",
		expires: credentials.expires,
		accountId: credentials.accountId,
		source: "cli",
	};
}

/** Store the CLI's login for a provider, unless the user disconnected it. True when stored. */
export async function borrowCliLogin(store: KeyStore, provider: string): Promise<boolean> {
	if (!isCliLoginProvider(provider) || (await isCliLoginOff(provider))) return false;
	try {
		await store.set(provider, serializeOAuthCredentials(await readCliLogin(provider)));
		return true;
	} catch (err) {
		console.info(`[cli-login] ${provider}: ${err instanceof Error ? err.message : String(err)}`);
		return false;
	}
}

/** Borrow every CLI login whose provider has no key yet. */
export async function borrowCliLogins(store: KeyStore): Promise<void> {
	await Promise.all(
		CLI_LOGIN_PROVIDERS.map(async (provider) => {
			if (!(await store.get(provider))) await borrowCliLogin(store, provider);
		}),
	);
}
