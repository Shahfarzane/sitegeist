/**
 * OAuth credentials stored as JSON in the provider keys store.
 * When a stored key starts with "{", it is parsed as OAuthCredentials.
 */
export interface OAuthCredentials {
	providerId: string;
	access: string;
	refresh: string;
	expires: number;
	accountId?: string;
	projectId?: string;
	/** "cli": borrowed from Claude Code or Codex (cli-login.ts); `refresh` is empty. */
	source?: "cli";
	/** On a borrowed Claude login: sitegeist's own login, used while Claude Code's has expired. */
	fallback?: OAuthCredentials;
}

/**
 * Check if a stored key value is JSON-encoded OAuth credentials.
 */
export function isOAuthCredentials(value: string): boolean {
	return value.startsWith("{");
}

/**
 * Parse a stored key value as OAuth credentials.
 */
export function parseOAuthCredentials(value: string): OAuthCredentials {
	return JSON.parse(value) as OAuthCredentials;
}

/**
 * Serialize OAuth credentials for storage.
 */
export function serializeOAuthCredentials(credentials: OAuthCredentials): string {
	return JSON.stringify(credentials);
}
