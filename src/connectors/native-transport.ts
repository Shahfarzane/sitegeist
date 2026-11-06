/**
 * MCP over the native host, for servers that run as local commands. The extension only names a
 * connector; the command itself comes from the CLI's config file on this computer, so nothing a
 * page or a model says can make the host run a program.
 */

import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { hostCapabilities } from "../bridge/host-capabilities.js";
import { CAPABILITY_CONNECTORS, type HostConnectorMessage, NATIVE_HOST_NAME } from "../bridge/protocol.js";

export class NativeConnectorTransport implements Transport {
	onclose?: () => void;
	onerror?: (error: Error) => void;
	onmessage?: <T extends JSONRPCMessage>(message: T) => void;

	private port?: chrome.runtime.Port;
	/** Messages over the 1 MiB native limit arrive in parts. */
	private partial = "";

	constructor(private readonly name: string) {}

	async start(): Promise<void> {
		const port = chrome.runtime.connectNative(NATIVE_HOST_NAME);
		this.port = port;
		port.onMessage.addListener((message: HostConnectorMessage) => this.receive(message));
		port.onDisconnect.addListener(() => {
			this.port = undefined;
			if (chrome.runtime.lastError) this.onerror?.(new Error(chrome.runtime.lastError.message));
			this.onclose?.();
		});
		port.postMessage({ type: "connector_open", name: this.name });
	}

	private receive(message: HostConnectorMessage): void {
		if (message.type === "connector_message") this.onmessage?.(message.message as JSONRPCMessage);
		else if (message.type === "connector_part") {
			this.partial += message.data;
			if (!message.last) return;
			const whole = this.partial;
			this.partial = "";
			this.onmessage?.(JSON.parse(whole) as JSONRPCMessage);
		} else if (message.type === "connector_closed") {
			this.onerror?.(new Error(message.error ?? `${this.name} stopped`));
			this.port?.disconnect();
			this.port = undefined;
			this.onclose?.();
		}
	}

	async send(message: JSONRPCMessage): Promise<void> {
		if (!this.port) throw new Error(`${this.name} is not connected`);
		this.port.postMessage({ type: "connector_send", message });
	}

	async close(): Promise<void> {
		this.port?.disconnect();
		this.port = undefined;
		this.onclose?.();
	}
}

/** Names of the local connectors configured on this computer; empty without a current CLI. */
export async function localConnectorNames(): Promise<string[]> {
	if (!(await hostCapabilities()).includes(CAPABILITY_CONNECTORS)) return [];
	try {
		const response = (await chrome.runtime.sendNativeMessage(NATIVE_HOST_NAME, { type: "connector_list" })) as
			| { names?: string[] }
			| undefined;
		return response?.names ?? [];
	} catch {
		return [];
	}
}
