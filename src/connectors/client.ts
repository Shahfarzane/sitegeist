/**
 * One MCP server the panel agent talks to: a remote HTTP server (with headers or OAuth), or a
 * local command run by the native host. The SDK does the protocol; this adds what an extension
 * page needs on top.
 */

import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type {
	OAuthClientInformationMixed,
	OAuthClientMetadata,
	OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { jsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/types.js";
import { waitForOAuthRedirect } from "../oauth/browser-oauth.js";
import type { Connector, ConnectorAuth } from "../storage/stores/connectors-store.js";
import { NativeConnectorTransport } from "./native-transport.js";

/** The tab hits this and fails to load, which is the point: the code is in its URL. */
const REDIRECT_HOST = "127.0.0.1:53917";
const REDIRECT_URL = `http://${REDIRECT_HOST}/sitegeist/oauth`;

/** The SDK's default validator compiles schemas with `new Function`, which extension CSP forbids. */
const noOutputValidation: jsonSchemaValidator = {
	getValidator: () => (input) => ({ valid: true, data: input as never, errorMessage: undefined }),
};

export class LoginRequiredError extends Error {
	constructor(name: string) {
		super(`${name} needs you to log in. Open Settings > Connectors.`);
	}
}

class StoredAuth implements OAuthClientProvider {
	authorizationUrl?: URL;
	/** Ties the redirect to this login; PKCE already stops a foreign code from being exchanged. */
	readonly expectedState = crypto.randomUUID();

	state(): string {
		return this.expectedState;
	}

	constructor(
		private readonly connector: Connector,
		private readonly persist: (auth: ConnectorAuth) => Promise<void>,
	) {}

	private get auth(): ConnectorAuth {
		return this.connector.auth ?? {};
	}

	private async update(change: Partial<ConnectorAuth>): Promise<void> {
		this.connector.auth = { ...this.auth, ...change };
		await this.persist(this.connector.auth);
	}

	get redirectUrl(): string {
		return REDIRECT_URL;
	}

	get clientMetadata(): OAuthClientMetadata {
		return {
			client_name: "Sitegeist",
			redirect_uris: [REDIRECT_URL],
			grant_types: ["authorization_code", "refresh_token"],
			response_types: ["code"],
			token_endpoint_auth_method: "none",
		};
	}

	clientInformation(): OAuthClientInformationMixed | undefined {
		return this.auth.clientInformation as OAuthClientInformationMixed | undefined;
	}

	saveClientInformation(info: OAuthClientInformationMixed): Promise<void> {
		return this.update({ clientInformation: info as unknown as Record<string, unknown> });
	}

	tokens(): OAuthTokens | undefined {
		return this.auth.tokens as OAuthTokens | undefined;
	}

	saveTokens(tokens: OAuthTokens): Promise<void> {
		return this.update({ tokens: tokens as unknown as Record<string, unknown> });
	}

	redirectToAuthorization(url: URL): void {
		this.authorizationUrl = url;
	}

	saveCodeVerifier(codeVerifier: string): Promise<void> {
		return this.update({ codeVerifier });
	}

	codeVerifier(): string {
		const verifier = this.auth.codeVerifier;
		if (!verifier) throw new Error("No code verifier saved");
		return verifier;
	}

	invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): Promise<void> {
		if (scope === "all")
			return this.update({ clientInformation: undefined, tokens: undefined, codeVerifier: undefined });
		if (scope === "client") return this.update({ clientInformation: undefined });
		if (scope === "tokens") return this.update({ tokens: undefined });
		if (scope === "verifier") return this.update({ codeVerifier: undefined });
		return Promise.resolve();
	}
}

export interface ConnectorTool {
	name: string;
	title?: string;
	description?: string;
	inputSchema: Record<string, unknown>;
}

export interface ToolContent {
	type: string;
	text?: string;
	data?: string;
	mimeType?: string;
	resource?: unknown;
}

export class ConnectorClient {
	private client?: Client;
	/** Kept apart from the client: a connect that times out has a transport but no client yet. */
	private transport?: Transport;
	/** Set once closed: a connect still in flight (it timed out) must not open anything new. */
	private closed = false;

	constructor(
		readonly connector: Connector,
		private readonly persistAuth: (auth: ConnectorAuth) => Promise<void>,
	) {}

	private makeClient(): Client {
		return new Client(
			{ name: "sitegeist", version: chrome.runtime.getManifest().version },
			{ jsonSchemaValidator: noOutputValidation },
		);
	}

	private async attach(transport: Transport): Promise<void> {
		if (this.closed) throw new Error(`${this.connector.name} was closed`);
		this.transport = transport;
		const client = this.makeClient();
		await client.connect(transport);
		if (this.closed) {
			await client.close().catch(() => undefined);
			throw new Error(`${this.connector.name} was closed`);
		}
		this.client = client;
	}

	private remoteOptions(provider: StoredAuth) {
		const headers = this.connector.headers;
		return { authProvider: provider, ...(headers ? { requestInit: { headers } } : {}) };
	}

	/** Connect with what is stored. Throws LoginRequiredError when the server wants a login. */
	async connect(): Promise<void> {
		const { connector } = this;
		if (connector.kind === "local") {
			await this.attach(new NativeConnectorTransport(connector.name));
			return;
		}
		if (!connector.url) throw new Error(`${connector.name} has no URL`);
		const url = new URL(connector.url);
		const provider = new StoredAuth(connector, this.persistAuth);
		try {
			await this.attach(new StreamableHTTPClientTransport(url, this.remoteOptions(provider)));
		} catch (err) {
			if (err instanceof UnauthorizedError) throw new LoginRequiredError(connector.name);
			if (this.closed) throw err;
			// Servers from before Streamable HTTP only speak SSE.
			try {
				await this.attach(new SSEClientTransport(url, this.remoteOptions(provider)));
			} catch (fallback) {
				if (fallback instanceof UnauthorizedError) throw new LoginRequiredError(connector.name);
				throw err;
			}
		}
	}

	/** The user asked to log in: run the OAuth flow in a tab, then connect. */
	async login(): Promise<void> {
		const { connector } = this;
		if (!connector.url) throw new Error(`${connector.name} has no URL`);
		const provider = new StoredAuth(connector, this.persistAuth);
		const url = new URL(connector.url);
		const transport = new StreamableHTTPClientTransport(url, this.remoteOptions(provider));
		try {
			await this.attach(transport);
			return;
		} catch (err) {
			if (!(err instanceof UnauthorizedError) || !provider.authorizationUrl) throw err;
		}
		const redirect = await waitForOAuthRedirect(provider.authorizationUrl.toString(), REDIRECT_HOST);
		if (redirect.searchParams.get("state") !== provider.expectedState)
			throw new Error("The login redirect did not match");
		const code = redirect.searchParams.get("code");
		if (!code) throw new Error(redirect.searchParams.get("error") ?? "The login returned no code");
		await transport.finishAuth(code);
		await this.attach(new StreamableHTTPClientTransport(url, this.remoteOptions(provider)));
	}

	async tools(): Promise<ConnectorTool[]> {
		if (!this.client) throw new Error("Not connected");
		const tools: ConnectorTool[] = [];
		let cursor: string | undefined;
		do {
			const page = await this.client.listTools(cursor ? { cursor } : undefined);
			tools.push(...(page.tools as ConnectorTool[]));
			cursor = page.nextCursor;
		} while (cursor);
		return tools;
	}

	async call(
		name: string,
		args: Record<string, unknown>,
		signal?: AbortSignal,
	): Promise<{ content: ToolContent[]; isError: boolean; structured?: unknown }> {
		if (!this.client) throw new Error("Not connected");
		const result = await this.client.callTool({ name, arguments: args }, undefined, {
			signal,
			timeout: 120000,
			resetTimeoutOnProgress: true,
		});
		return {
			content: (result.content as ToolContent[]) ?? [],
			isError: result.isError === true,
			structured: result.structuredContent,
		};
	}

	async close(): Promise<void> {
		this.closed = true;
		await this.client?.close().catch(() => undefined);
		await this.transport?.close().catch(() => undefined);
		this.client = undefined;
		this.transport = undefined;
	}
}
