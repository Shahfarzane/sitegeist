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
	get(name: string): Promise<Connector | null>;
	save(connector: Connector): Promise<void>;
}

/** Tool names go to the provider: letters, digits, _ and -, at most 64 characters. */
export function connectorToolName(connector: string, tool: string): string {
	const clean = (s: string) => s.replace(/[^a-zA-Z0-9_-]+/g, "_").replace(/^_+|_+$/g, "");
	return `${clean(connector).slice(0, 20)}__${clean(tool)}`.slice(0, 64);
}

/** More text than a model can use, and rendering it freezes every panel of the extension. */
const MAX_RESULT_CHARS = 60000;

/** MCP content in the shape tool results use. The text budget is for the whole result. */
export function toToolContent(content: ToolContent[], structured?: unknown): Array<TextContent | ImageContent> {
	const out: Array<TextContent | ImageContent> = [];
	let budget = MAX_RESULT_CHARS;
	const addText = (text: string) => {
		if (budget <= 0) return;
		if (text.length <= budget) {
			out.push({ type: "text", text });
			budget -= text.length;
			return;
		}
		out.push({
			type: "text",
			text: `${text.slice(0, budget)}\n[Truncated: the result has ${text.length} characters. Ask for less, for example with a narrower query.]`,
		});
		budget = 0;
	};
	for (const block of content) {
		if (block.type === "text") addText(block.text ?? "");
		else if (block.type === "image" && block.data) {
			out.push({ type: "image", data: block.data, mimeType: block.mimeType ?? "image/png" });
		} else addText(JSON.stringify(block.resource ?? block));
	}
	// Tools with an output schema may answer in structuredContent alone.
	if (out.length === 0 && structured !== undefined) addText(JSON.stringify(structured));
	return out.length > 0 ? out : [{ type: "text", text: "(no output)" }];
}

/**
 * Two connectors can clean up to the same name, and providers refuse a duplicate tool. A later one
 * gets a number; it still reaches its own server, because the name is only what the model sees.
 */
export function uniqueToolNames(tools: AgentTool<any>[]): AgentTool<any>[] {
	const seen = new Set<string>();
	return tools.map((tool) => {
		let name = tool.name;
		for (let n = 2; seen.has(name); n++) name = `${tool.name.slice(0, 60)}_${n}`;
		seen.add(name);
		return name === tool.name ? tool : { ...tool, name };
	});
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
			const content = toToolContent(result.content, result.structured);
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
	/** Every tool this manager gave out, so a refresh can take them all back. */
	private issued = new WeakSet<AgentTool<any>>();

	constructor(private readonly storage: ConnectorStorage) {}

	owns(tool: AgentTool<any>): boolean {
		return this.issued.has(tool);
	}

	adopt(tool: AgentTool<any>): void {
		this.issued.add(tool);
	}

	get tools(): AgentTool<any>[] {
		return this.agentTools;
	}

	get status(): ConnectorStatus[] {
		return [...this.statuses.values()];
	}

	private clientFor(connector: Connector): ConnectorClient {
		return new ConnectorClient(connector, async (auth: ConnectorAuth) => {
			connector.auth = auth;
			// Against the stored record: another panel may have turned this off or removed it.
			const current = await this.storage.get(connector.name);
			if (current) await this.storage.save({ ...current, auth });
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
		this.agentTools = uniqueToolNames(groups.flat());
		for (const tool of this.agentTools) this.adopt(tool);
		return this.agentTools;
	}

	/** Run a connector's OAuth login. Refresh afterwards to pick up its tools. */
	async login(connector: Connector): Promise<void> {
		const client = this.clientFor(connector);
		await client.login();
		await client.close();
	}

	private async closeAll(): Promise<void> {
		await Promise.all([...this.clients.values()].map((c) => c.close()));
		this.clients.clear();
		this.statuses.clear();
		this.agentTools = [];
	}
}
