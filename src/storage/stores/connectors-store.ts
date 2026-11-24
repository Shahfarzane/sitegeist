import { Store, type StoreConfig } from "@mariozechner/pi-web-ui";
import type {
	OAuthDiscoveryState,
	StoredOAuthClientInformation,
	StoredOAuthTokens,
} from "@modelcontextprotocol/client";

/** OAuth state of a remote connector, kept with it as the SDK hands it over. */
export interface ConnectorAuth {
	clientInformation?: StoredOAuthClientInformation;
	tokens?: StoredOAuthTokens;
	codeVerifier?: string;
	discoveryState?: OAuthDiscoveryState;
}

/** An MCP server the panel agent can use. */
export interface Connector {
	name: string;
	/** "remote" is an HTTP server; "local" a command in the CLI's connector list. */
	kind: "remote" | "local";
	url?: string;
	/** Sent with every request, e.g. Authorization. */
	headers?: Record<string, string>;
	enabled: boolean;
	auth?: ConnectorAuth;
	createdAt: string;
}

export class ConnectorsStore extends Store {
	getConfig(): StoreConfig {
		return { name: "connectors" };
	}

	async list(): Promise<Connector[]> {
		const keys = await this.getBackend().keys("connectors");
		const connectors = await Promise.all(keys.map((key) => this.getBackend().get<Connector>("connectors", key)));
		return connectors.filter((c): c is Connector => c !== null).sort((a, b) => a.name.localeCompare(b.name));
	}

	get(name: string): Promise<Connector | null> {
		return this.getBackend().get("connectors", name);
	}

	async save(connector: Connector): Promise<void> {
		await this.getBackend().set("connectors", connector.name, connector);
	}

	async delete(name: string): Promise<void> {
		await this.getBackend().delete("connectors", name);
	}
}
