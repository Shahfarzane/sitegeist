/**
 * One MCP server the panel agent talks to: a remote HTTP server (with headers or OAuth), or a
 * local command run by the native host. The SDK does the protocol; this adds what an extension
 * page needs on top.
 */

import {
	Client,
	type ClientOptions,
	IssuerMismatchError,
	type OAuthClientMetadata,
	type OAuthClientProvider,
	type OAuthDiscoveryState,
	ProtocolError,
	ProtocolErrorCode,
	SdkError,
	SdkErrorCode,
	SSEClientTransport,
	type StoredOAuthClientInformation,
	type StoredOAuthTokens,
	StreamableHTTPClientTransport,
	type Transport,
	UnauthorizedError,
} from "@modelcontextprotocol/client";
import { waitForOAuthRedirect } from "../oauth/browser-oauth.js";
import type { Connector, ConnectorAuth } from "../storage/stores/connectors-store.js";
import { NativeConnectorTransport } from "./native-transport.js";

/** The tab hits this and fails to load, which is the point: the code is in its URL. */
const REDIRECT_HOST = "127.0.0.1:53917";
const REDIRECT_URL = `http://${REDIRECT_HOST}/sitegeist/oauth`;

/**
 * A 2026 server answers server/discover at once. A local server that stays silent this long is
 * taken as one from before 2026 and gets initialize instead; the manager allows 8 s in all.
 */
const LOCAL_PROBE_TIMEOUT_MS = 3000;

/** The RFC 6749 codes an authorization server may put in a failed redirect; anything else is not shown. */
const OAUTH_ERROR_CODES = new Set([
	"access_denied",
	"invalid_request",
	"invalid_scope",
	"server_error",
	"temporarily_unavailable",
	"unauthorized_client",
	"unsupported_response_type",
]);

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

	// Stored and returned as the SDK hands them over: it stamps the issuer on them and treats a
	// value bound to another authorization server as absent.
	clientInformation(): StoredOAuthClientInformation | undefined {
		return this.auth.clientInformation;
	}

	saveClientInformation(clientInformation: StoredOAuthClientInformation): Promise<void> {
		return this.update({ clientInformation });
	}

	tokens(): StoredOAuthTokens | undefined {
		return this.auth.tokens;
	}

	saveTokens(tokens: StoredOAuthTokens): Promise<void> {
		return this.update({ tokens });
	}

	/** Which authorization server the redirect went to, so the code is exchanged at the same one. */
	discoveryState(): OAuthDiscoveryState | undefined {
		return this.auth.discoveryState;
	}

	saveDiscoveryState(discoveryState: OAuthDiscoveryState): Promise<void> {
		return this.update({ discoveryState });
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
			return this.update({
				clientInformation: undefined,
				tokens: undefined,
				codeVerifier: undefined,
				discoveryState: undefined,
			});
		if (scope === "client") return this.update({ clientInformation: undefined });
		if (scope === "tokens") return this.update({ tokens: undefined });
		if (scope === "verifier") return this.update({ codeVerifier: undefined });
		return this.update({ discoveryState: undefined });
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

/** A connector asked the user something mid-call: the 2026 input_required result, which the panel cannot show. */
function isInputRequest(err: unknown): boolean {
	if (err instanceof SdkError && err.code === SdkErrorCode.UnsupportedResultType) return true;
	// A server that checks capabilities first refuses instead: this client declares none.
	return err instanceof ProtocolError && err.code === ProtocolErrorCode.MissingRequiredClientCapability;
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

	private makeClient(versionNegotiation: ClientOptions["versionNegotiation"]): Client {
		return new Client(
			{ name: "sitegeist", version: chrome.runtime.getManifest().version },
			{
				versionNegotiation,
				// No capabilities and no auto-fulfilment: a question a connector asks mid-call
				// fails that call with a clear error instead of waiting on a handler.
				inputRequired: { autoFulfill: false },
			},
		);
	}

	/**
	 * `legacy` connects with initialize and no server/discover probe: SSE servers, and local ones
	 * known to predate 2026.
	 */
	private async attach(transport: Transport, legacy = false, probeTimeoutMs?: number): Promise<void> {
		if (this.closed) throw new Error(`${this.connector.name} was closed`);
		this.transport = transport;
		const client = this.makeClient(
			legacy ? undefined : { mode: "auto", ...(probeTimeoutMs ? { probe: { timeoutMs: probeTimeoutMs } } : {}) },
		);
		await client.connect(transport, legacy ? { prior: { kind: "legacy" } } : undefined);
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

	private async connectLocal(name: string): Promise<void> {
		try {
			await this.attach(new NativeConnectorTransport(name), false, LOCAL_PROBE_TIMEOUT_MS);
		} catch (err) {
			// Some servers from before 2026 exit on any request ahead of initialize: start it again
			// and skip the probe.
			if (this.closed || !(err instanceof SdkError) || err.code !== SdkErrorCode.EraNegotiationFailed) throw err;
			await this.transport?.close().catch(() => undefined);
			await this.attach(new NativeConnectorTransport(name), true);
		}
	}

	/** Connect with what is stored. Throws LoginRequiredError when the server wants a login. */
	async connect(): Promise<void> {
		const { connector } = this;
		if (connector.kind === "local") {
			await this.connectLocal(connector.name);
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
				await this.attach(new SSEClientTransport(url, this.remoteOptions(provider)), true);
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
		const options = this.remoteOptions(provider);
		let transport: StreamableHTTPClientTransport | SSEClientTransport = new StreamableHTTPClientTransport(
			url,
			options,
		);
		let sse = false;
		try {
			await this.attach(transport);
			return;
		} catch (err) {
			if (!(err instanceof UnauthorizedError)) {
				// A server from before Streamable HTTP rejects its POSTs: its login runs over SSE.
				transport = new SSEClientTransport(url, options);
				sse = true;
				try {
					await this.attach(transport, true);
					return;
				} catch (fallback) {
					if (!(fallback instanceof UnauthorizedError)) throw err;
				}
			}
			if (!provider.authorizationUrl) throw err;
		}
		const redirect = await waitForOAuthRedirect(provider.authorizationUrl.toString(), REDIRECT_HOST);
		const params = redirect.searchParams;
		// The SDK checks iss but not state.
		if (params.get("state") !== provider.expectedState) throw new Error("The login redirect did not match");
		if (!params.get("code")) {
			const code = params.get("error") ?? "";
			throw new Error(`The login did not finish${OAUTH_ERROR_CODES.has(code) ? ` (${code})` : ""}`);
		}
		try {
			await transport.finishAuth(params);
		} catch (err) {
			// A mix-up attack: the redirect came from another authorization server. Its text is not shown.
			if (err instanceof IssuerMismatchError)
				throw new Error("The login came back from a different authorization server and was refused");
			throw err;
		}
		await this.attach(
			sse ? new SSEClientTransport(url, options) : new StreamableHTTPClientTransport(url, options),
			sse,
		);
	}

	async tools(): Promise<ConnectorTool[]> {
		if (!this.client) throw new Error("Not connected");
		// Without a cursor the SDK walks every page (up to 64).
		const { tools } = await this.client.listTools();
		return tools.map((tool) => ({
			name: tool.name,
			title: tool.title,
			description: tool.description,
			inputSchema: tool.inputSchema,
		}));
	}

	async call(
		name: string,
		args: Record<string, unknown>,
		signal?: AbortSignal,
	): Promise<{ content: ToolContent[]; isError: boolean; structured?: unknown }> {
		if (!this.client) throw new Error("Not connected");
		try {
			const result = await this.client.callTool(
				{ name, arguments: args },
				{
					signal,
					timeout: 120000,
					resetTimeoutOnProgress: true,
				},
			);
			return {
				content: result.content as ToolContent[],
				isError: result.isError === true,
				structured: result.structuredContent,
			};
		} catch (err) {
			if (isInputRequest(err))
				throw new Error(
					`${this.connector.name} asked for input during ${name}, and the side panel cannot answer that. Use another tool or ask the user to run it elsewhere.`,
				);
			throw err;
		}
	}

	async close(): Promise<void> {
		this.closed = true;
		await this.client?.close().catch(() => undefined);
		await this.transport?.close().catch(() => undefined);
		this.client = undefined;
		this.transport = undefined;
	}
}
