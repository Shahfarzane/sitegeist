/**
 * Browser OAuth integration for sitegeist.
 *
 * Credentials are stored as JSON strings in the provider keys store.
 * When getApiKey encounters a JSON string, it parses it as OAuthCredentials,
 * refreshes the token if expired, and returns the access token.
 */

import { loginAnthropic, refreshAnthropic } from "./anthropic.js";
import { TokenRequestError } from "./browser-oauth.js";
import {
	cliName,
	currentCliLogin,
	isCliLoginOff,
	isCliLoginProvider,
	keepsFallback,
	readCliLogin,
} from "./cli-login.js";
import { loginGitHubCopilot, refreshGitHubCopilot } from "./github-copilot.js";
import { loginGeminiCli, refreshGeminiCli } from "./google-gemini-cli.js";
import { loginOpenAICodex, refreshOpenAICodex } from "./openai-codex.js";
import {
	isOAuthCredentials,
	type OAuthCredentials,
	parseOAuthCredentials,
	serializeOAuthCredentials,
} from "./types.js";

export { isOAuthCredentials, type OAuthCredentials, parseOAuthCredentials, serializeOAuthCredentials };

export type OAuthProviderId = "anthropic" | "openai-codex" | "github-copilot" | "google-gemini-cli";

const OAUTH_PROVIDERS: Record<OAuthProviderId, { name: string }> = {
	anthropic: { name: "Anthropic (Claude Pro/Max)" },
	"openai-codex": { name: "ChatGPT Plus/Pro" },
	"github-copilot": { name: "GitHub Copilot" },
	"google-gemini-cli": { name: "Google Gemini" },
};

/**
 * Check if a provider supports OAuth login.
 */
export function isOAuthProvider(provider: string): provider is OAuthProviderId {
	return provider in OAUTH_PROVIDERS;
}

/**
 * Get display name for an OAuth provider.
 */
export function getOAuthProviderName(provider: OAuthProviderId): string {
	return OAUTH_PROVIDERS[provider].name;
}

/**
 * Callback for device code flows (GitHub Copilot).
 * Called with the user code and verification URL that the user needs to enter.
 */
export type DeviceCodeCallback = (info: { userCode: string; verificationUri: string }) => void;

/**
 * Run the OAuth login flow for a provider.
 * Returns credentials to store.
 */
export async function oauthLogin(
	provider: OAuthProviderId,
	_proxyUrl?: string,
	onDeviceCode?: DeviceCodeCallback,
): Promise<OAuthCredentials> {
	switch (provider) {
		case "anthropic":
			return loginAnthropic();
		case "openai-codex":
			return loginOpenAICodex();
		case "github-copilot":
			return loginGitHubCopilot(onDeviceCode || (() => {}));
		case "google-gemini-cli":
			return loginGeminiCli();
		default:
			throw new Error(`Unknown OAuth provider: ${provider}`);
	}
}

/**
 * Refresh OAuth credentials for a provider.
 * Returns updated credentials to store.
 */
export async function oauthRefresh(credentials: OAuthCredentials, _proxyUrl?: string): Promise<OAuthCredentials> {
	switch (credentials.providerId) {
		case "anthropic":
			return refreshAnthropic(credentials);
		case "openai-codex":
			return refreshOpenAICodex(credentials);
		case "github-copilot":
			return refreshGitHubCopilot(credentials);
		case "google-gemini-cli":
			return refreshGeminiCli(credentials);
		default:
			throw new Error(`Unknown OAuth provider: ${credentials.providerId}`);
	}
}

/**
 * Resolve an API key from stored value.
 * If the value is a plain string, return it directly.
 * If it is JSON (OAuth credentials), refresh if expired and return the access token.
 * Updates storage with refreshed credentials.
 */
export async function resolveApiKey(
	storedValue: string,
	provider: string,
	storage: { set: (provider: string, value: string) => Promise<void> },
	proxyUrl?: string,
): Promise<string> {
	if (!isOAuthCredentials(storedValue)) {
		return storedValue;
	}

	let credentials = parseOAuthCredentials(storedValue);

	if (credentials.source === "cli" && isCliLoginProvider(provider)) {
		// Borrowed from Claude Code or Codex: the CLI's own store has the current token.
		const fallback = credentials.fallback;
		let current: OAuthCredentials;
		let token: string;
		try {
			current = { ...(await currentCliLogin(provider, credentials, { fallback: !!fallback })), fallback };
			token = current.access;
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			if (!fallback) {
				if (!keepsFallback(provider)) throw error;
				throw new Error(`${reason} Or log in under Settings > Providers to give sitegeist a fallback login.`);
			}
			// Claude Code's login lapsed: sitegeist's own login stands in until it is back.
			let own = fallback;
			if (Date.now() >= own.expires - 60_000) {
				try {
					own = await oauthRefresh(own, proxyUrl);
				} catch (refreshError) {
					console.error(`Failed to refresh the fallback login for ${provider}:`, refreshError);
					throw new Error(`${reason}, and the sitegeist login for ${provider} could not be refreshed`);
				}
			}
			current = { ...credentials, fallback: own };
			token = own.access;
			console.info(`[cli-login] ${provider}: ${cliName(provider)} login expired, using the sitegeist login`);
		}
		const serialized = serializeOAuthCredentials(current);
		// Not after a Logout that happened while the lookup ran.
		if (serialized !== storedValue && !(await isCliLoginOff(provider))) await storage.set(provider, serialized);
		return token;
	} else if (Date.now() >= credentials.expires - 60_000) {
		// Refresh if expired (or within 60s of expiry)
		try {
			credentials = await oauthRefresh(credentials, proxyUrl);
		} catch (error) {
			console.error(`Failed to refresh OAuth token for ${provider}:`, error);
			// The token endpoint turned sitegeist's own login down for good (not a network error):
			// the CLI's login, if there is one, still works.
			const rejected = error instanceof TokenRequestError && error.status >= 400 && error.status < 500;
			const fallback =
				rejected && isCliLoginProvider(provider) && !(await isCliLoginOff(provider))
					? await readCliLogin(provider).catch(() => undefined)
					: undefined;
			if (!fallback) throw new Error(`OAuth token expired and refresh failed for ${provider}`);
			credentials = fallback;
		}
		await storage.set(provider, serializeOAuthCredentials(credentials));
	}

	// Gemini CLI expects the API key as JSON with token and projectId
	if (credentials.providerId === "google-gemini-cli") {
		return JSON.stringify({ token: credentials.access, projectId: credentials.projectId });
	}

	return credentials.access;
}
