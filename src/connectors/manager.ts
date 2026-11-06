/** Keeps the enabled connectors of a panel connected and turns their tools into agent tools. */

import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { ImageContent, TextContent } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import type { Connector, ConnectorAuth } from "../storage/stores/connectors-store.js";
import { ConnectorClient, type ConnectorTool, LoginRequiredError, type ToolContent } from "./client.js";
import { localConnectorNames } from "./native-transport.js";

const CONNECT_TIMEOUT_MS = 8000;

export type ConnectorState = "connected" | "needs-login" | "error" | "off";

export interface ConnectorStatus {
	connector: Connector;
	state: ConnectorState;
	tools: number;
	error?: string;
}

export interface ConnectorStorage {
	list(): Promise<Connector[]>;
	save(connector: Connector): Promise<void>;
}

/** Tool names go to the provider: letters, digits, _ and -, at most 64 characters. */
export function connectorToolName(connector: string, tool: string): string {
	const clean = (s: string) => s.replace(/[^a-zA-Z0-9_-]+/g, "_").replace(/^_+|_+$/g, "");
	return `${clean(connector).slice(0, 20)}__${clean(tool)}`.slice(0, 64);
}

/** More text than a model can use, and rendering it freezes every panel of the extension. */
const MAX_RESULT_CHARS = 60000;

function capped(text: string): string {
	if (text.length <= MAX_RESULT_CHARS) return text;
	return `${text.slice(0, MAX_RESULT_CHARS)}\n[Truncated: the result has ${text.length} characters. Ask for less, for example with a narrower query.]`;
}

/** MCP content in the shape tool results use. */
export function toToolContent(content: ToolContent[]): Array<TextContent | ImageContent> {
	const out: Array<TextContent | ImageContent> = [];
	for (const block of content) {
		if (block.type === "text") out.push({ type: "text", text: capped(block.text ?? "") });
		else if (block.type === "image" && block.data) {
			out.push({ type: "image", data: block.data, mimeType: block.mimeType ?? "image/png" });
		} else out.push({ type: "text", text: capped(JSON.stringify(block.resource ?? block)) });
	}
	return out.length > 0 ? out : [{ type: "text", text: "(no output)" }];
}

function toAgentTool(client: ConnectorClient, tool: ConnectorTool): AgentTool<any> {
	const label = client.connector.name;
	return {
		name: connectorToolName(label, tool.name),
		label: `${label}: ${tool.title ?? tool.name}`,
		description: tool.description ?? `${tool.name} from ${label}`,
		parameters: Type.Unsafe<Record<string, unknown>>(tool.inputSchema),
		execute: async (_toolCallId, args, signal) => {
			const result = await client.call(tool.name, (args ?? {}) as Record<string, unknown>, signal);
			const content = toToolContent(result.content);
			if (result.isError) {
				throw new Error(content.map((c) => (c.type === "text" ? c.text : "")).join("\n") || `${tool.name} failed`);
			}
			return { content, details: {} };
		},
	};
}

function withTimeout<T>(promise: Promise<T>, name: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout>;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error(`${name} did not answer`)), CONNECT_TIMEOUT_MS);
	});
	return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export class ConnectorManager {
	private clients = new Map<string, ConnectorClient>();
	private statuses = new Map<string, ConnectorStatus>();
	private agentTools: AgentTool<any>[] = [];

	constructor(private readonly storage: ConnectorStorage) {}

	get tools(): AgentTool<any>[] {
		return this.agentTools;
	}

	get status(): ConnectorStatus[] {
		return [...this.statuses.values()];
	}

	private clientFor(connector: Connector): ConnectorClient {
		return new ConnectorClient(connector, async (auth: ConnectorAuth) => {
			connector.auth = auth;
			await this.storage.save(connector);
		});
	}

	/** Remote connectors from storage, local ones from this computer's config. */
	async all(): Promise<Connector[]> {
		const stored = await this.storage.list();
		const known = new Set(stored.map((c) => c.name));
		const local = (await localConnectorNames())
			.filter((name) => !known.has(name))
			.map((name): Connector => ({ name, kind: "local", enabled: true, createdAt: new Date().toISOString() }));
		return [...stored, ...local];
	}

	private async connectOne(connector: Connector): Promise<AgentTool<any>[]> {
		const client = this.clientFor(connector);
		try {
			await withTimeout(client.connect(), connector.name);
			const tools = await withTimeout(client.tools(), connector.name);
			this.clients.set(connector.name, client);
			this.statuses.set(connector.name, { connector, state: "connected", tools: tools.length });
			return tools.map((tool) => toAgentTool(client, tool));
		} catch (err) {
			await client.close();
			const state = err instanceof LoginRequiredError ? "needs-login" : "error";
			const error = err instanceof Error ? err.message : String(err);
			this.statuses.set(connector.name, { connector, state, tools: 0, error });
			return [];
		}
	}

	/** Connect everything that is on. Failures stay with their connector and block nothing else. */
	async refresh(): Promise<AgentTool<any>[]> {
		await this.closeAll();
		const connectors = await this.all();
		for (const connector of connectors) {
			if (!connector.enabled) this.statuses.set(connector.name, { connector, state: "off", tools: 0 });
		}
		const groups = await Promise.all(connectors.filter((c) => c.enabled).map((c) => this.connectOne(c)));
		this.agentTools = groups.flat();
		return this.agentTools;
	}

	/** Run a connector's OAuth login, then pick up its tools. */
	async login(connector: Connector): Promise<void> {
		const client = this.clientFor(connector);
		await client.login();
		await client.close();
		await this.refresh();
	}

	private async closeAll(): Promise<void> {
		await Promise.all([...this.clients.values()].map((c) => c.close()));
		this.clients.clear();
		this.statuses.clear();
		this.agentTools = [];
	}
}
