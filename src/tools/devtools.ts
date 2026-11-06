/** read_console and read_network for the panel agent: debug a page the way a developer would. */

import type { AgentTool } from "@mariozechner/pi-agent-core";
import { type Static, Type } from "@sinclair/typebox";
import { consoleEntries, enableConsoleCapture, enableNetworkCapture, networkEntries } from "../browser/cdp.js";
import { getCurrentBrowserSession } from "../browser/current.js";

const consoleSchema = Type.Object({
	onlyErrors: Type.Optional(Type.Boolean({ description: "Errors and exceptions only" })),
	pattern: Type.Optional(Type.String({ description: "Regex the message must match" })),
	clear: Type.Optional(Type.Boolean({ description: "Clear after reading" })),
	limit: Type.Optional(Type.Number({ description: "Newest messages to return (default 100)" })),
});

const networkSchema = Type.Object({
	urlPattern: Type.Optional(Type.String({ description: "Regex the URL must match" })),
	clear: Type.Optional(Type.Boolean({ description: "Clear after reading" })),
	limit: Type.Optional(Type.Number({ description: "Newest requests to return (default 100)" })),
});

async function currentTabId(): Promise<number> {
	const tab = await getCurrentBrowserSession().attachedCurrentTab();
	if (tab.id === undefined) throw new Error("No tab");
	return tab.id;
}

const CAPTURE_NOTE = "Capture starts with the first call; reload the page to see what happens while it loads.";

export function createConsoleTool(): AgentTool<typeof consoleSchema, { count: number }> {
	return {
		name: "read_console",
		label: "Read console",
		description: `Console messages and uncaught errors of the current tab. ${CAPTURE_NOTE}`,
		parameters: consoleSchema,
		execute: async (_toolCallId, args: Static<typeof consoleSchema>) => {
			const tabId = await currentTabId();
			await enableConsoleCapture(tabId);
			const entries = consoleEntries(tabId, args);
			const lines = entries.map((e) => `[${e.level}] ${e.text}`).join("\n");
			return {
				content: [{ type: "text", text: lines || "No console messages yet." }],
				details: { count: entries.length },
			};
		},
	};
}

export function createNetworkTool(): AgentTool<typeof networkSchema, { count: number }> {
	return {
		name: "read_network",
		label: "Read network",
		description: `Network requests of the current tab with method, status and type. ${CAPTURE_NOTE}`,
		parameters: networkSchema,
		execute: async (_toolCallId, args: Static<typeof networkSchema>) => {
			const tabId = await currentTabId();
			await enableNetworkCapture(tabId);
			const entries = networkEntries(tabId, args);
			const lines = entries
				.map(
					(e) =>
						`${e.method} ${e.status ?? e.failed ?? "pending"} ${e.url}${e.mimeType ? ` (${e.mimeType})` : ""}`,
				)
				.join("\n");
			return {
				content: [{ type: "text", text: lines || "No requests yet." }],
				details: { count: entries.length },
			};
		},
	};
}
