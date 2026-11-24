/**
 * `sitegeist mcp`: stdio MCP server that exposes the browser bridge to any MCP
 * client (Claude Code, Codex, omp, ...). Tool names mirror Claude in Chrome so
 * prompts written for it carry over.
 */

import { readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, resolve } from "node:path";
import { type CallToolResult, McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";
import { CHANNEL } from "../../src/channel.ts";
import { BridgeClient, BridgeRpcError, listBrowsers } from "./client.ts";
import { install, isInstalled } from "./install.ts";
import { PermissionPrompts, type Track } from "./permission-prompts.ts";
import { toolInput } from "./tool-schema.ts";
import { VERSION } from "./version.ts";

type Content = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

/** Native messaging frames top out at 1 MiB; a multiple of 4 keeps each chunk valid base64. */
const UPLOAD_CHUNK_CHARS = 600_000;
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

const MIME_TYPES: Record<string, string> = {
	".csv": "text/csv",
	".gif": "image/gif",
	".html": "text/html",
	".jpeg": "image/jpeg",
	".jpg": "image/jpeg",
	".json": "application/json",
	".log": "text/plain",
	".md": "text/markdown",
	".mov": "video/quicktime",
	".mp3": "audio/mpeg",
	".mp4": "video/mp4",
	".pdf": "application/pdf",
	".png": "image/png",
	".svg": "image/svg+xml",
	".txt": "text/plain",
	".webm": "video/webm",
	".webp": "image/webp",
	".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
	".zip": "application/zip",
};

/** Raw CDP results can be megabytes (DOM.getDocument depth -1, base64 captures). */
const CDP_RESULT_MAX_CHARS = 100_000;

function text(value: unknown): Content[] {
	return [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }];
}

interface SnapNode {
	ref: string;
	role: string;
	name: string;
	value?: string;
	href?: string;
	visible: boolean;
}

/** One line per element; same-origin links shortened to their path. */
function formatNodes(nodes: SnapNode[], pageUrl: string): string {
	let origin = "";
	try {
		origin = new URL(pageUrl).origin;
	} catch {
		/* no origin */
	}
	return nodes
		.map((n) => {
			let line = `${n.ref} ${n.role} ${JSON.stringify(n.name)}`;
			if (n.value) line += ` value=${JSON.stringify(n.value)}`;
			if (n.href) line += ` -> ${origin && n.href.startsWith(origin) ? n.href.slice(origin.length) || "/" : n.href}`;
			if (!n.visible) line += " (offscreen)";
			return line;
		})
		.join("\n");
}

interface PageSnapshot {
	url: string;
	title: string;
	viewport: { width: number; height: number; scrollY: number; pageHeight: number };
	nodes: SnapNode[];
	text: string;
	/** Length of the whole page text; absent from extensions that do not report it. */
	textLength?: number;
	dialogs?: unknown[];
}

/** read_page as compact text: a fraction of the tokens of pretty JSON, same information. */
function formatSnapshot(snap: PageSnapshot): string {
	const v = snap.viewport;
	const parts = [
		`Page: ${snap.title} | ${snap.url}`,
		`Viewport ${v.width}x${v.height}, scrollY ${v.scrollY} of ${v.pageHeight}`,
		`Elements (${snap.nodes.length}; use the ref with click/type/fill/scroll):`,
		formatNodes(snap.nodes, snap.url),
	];
	if (snap.text) {
		const cut = (snap.textLength ?? 0) > snap.text.length;
		// Without the note a cut text reads as the whole page, and the model answers from a part of it.
		parts.push("", cut ? `Text (first ${snap.text.length} of ${snap.textLength} characters; get_page_text has the rest):` : "Text:", snap.text);
	}
	return parts.join("\n") + dialogNote(snap);
}

/** Dialogs the page opened during a call, for results that are text instead of JSON. */
function dialogNote(result: { dialogs?: unknown[] }): string {
	return result.dialogs?.length ? `\nDialogs answered: ${JSON.stringify(result.dialogs)}` : "";
}

/** run_js takes one expression; statements fail to parse, and the raw error does not say why. */
const STATEMENT_ERROR = /SyntaxError: (?:Unexpected (?:token|identifier)(?!.*JSON)|Illegal return statement|Identifier '.*' has already been declared)/;
const STATEMENT_HINT = "run_js takes one expression. Wrap statements in an IIFE: (() => { const a = 1; return a; })()";

function harnessName(): string {
	const explicit = process.env.SITEGEIST_CLIENT_NAME;
	if (explicit) return explicit;
	if (process.env.CLAUDECODE || process.env.CLAUDE_CODE_ENTRYPOINT) return "claude";
	if (process.env.CODEX_HOME || process.env.CODEX_SANDBOX) return "codex";
	if (process.env.OMP_SESSION_ID || process.env.PI_SESSION_ID) return "omp";
	return "mcp";
}

/**
 * The browser session this server drives. Always set: without one every reconnect
 * (extension reload, worker restart) got a fresh session and lost its tabs. Claude Code
 * gives stdio servers CLAUDE_CODE_SESSION_ID, so every server process in one chat (a
 * subagent that declares sitegeist inline starts a fresh one per run) shares one tab
 * group. The process identity is the fallback.
 */
function sessionKey(): string {
	return (
		process.env.SITEGEIST_SESSION ||
		process.env.CLAUDE_CODE_SESSION_ID ||
		process.env.CODEX_THREAD_ID ||
		process.env.OMP_SESSION_ID ||
		process.env.PI_SESSION_ID ||
		`p${process.pid}-${Date.now().toString(36)}`
	);
}

export async function runMcpServer(): Promise<void> {
	if (!isInstalled()) {
		// First run from any harness completes setup; the extension reconnects on its alarm.
		const result = install();
		process.stderr.write(`[sitegeist] installed native host manifest (${result.written.length} browser dir(s))\n`);
	}

	const client = new BridgeClient({
		name: harnessName(),
		session: sessionKey(),
		onEvent: (event, data) => {
			if (event === "permission_request") void onPermissionRequest(data);
		},
	});
	const respond = (requestId: string, decision: "allow_once" | "allow_host" | "deny") =>
		client.call("permission.respond", { requestId, decision }).then(
			() => undefined,
			() => undefined,
		);
	const prompts = new PermissionPrompts(respond, (host) => {
		process.stderr.write(
			`[sitegeist] ${host} needs approval: run \`${CHANNEL.command} allow ${host}\`, use the side panel (Settings > Bridge), or set SITEGEIST_AUTO_ALLOW=1.\n`,
		);
	});

	async function onPermissionRequest(data: Record<string, unknown>): Promise<void> {
		const requestId = String(data.requestId);
		if (process.env.SITEGEIST_AUTO_ALLOW === "1") return respond(requestId, "allow_once");
		const callId = typeof data.callId === "number" ? data.callId : undefined;
		// Nothing of ours is waiting on it (the call already ended): the user can still answer in the side panel.
		if (!prompts.raise({ requestId, host: String(data.host), callId })) await respond(requestId, "deny");
	}

	function errorResult(err: unknown): { content: Content[]; isError: true } {
		const message = err instanceof BridgeRpcError ? `${err.rpc.code}: ${err.rpc.message}` : err instanceof Error ? err.message : String(err);
		return { content: text(message), isError: true };
	}

	/** A bridge call made on behalf of one tool call, so a permission question finds its way back. */
	type Bridge = <T = unknown>(method: string, params?: Record<string, unknown>, timeoutMs?: number) => Promise<T>;

	async function call(bridge: Bridge, method: string, params: Record<string, unknown> = {}): Promise<CallToolResult> {
		try {
			return { content: text(await bridge(method, params)) };
		} catch (err) {
			return errorResult(err);
		}
	}

	const instructions = [
		"sitegeist drives the user's real Chromium browser in the background: your own tab group, never in focus, no view of the user's other tabs.",
		"Every tool call is a full model turn, so make each one do as much as it can.",
		"navigate and tabs_create return the page once it holds still (elements with refs, and its text): no wait or read_page after them, unless it still shows a placeholder; then wait for the text you expect.",
		"click with read:true returns the page after the click.",
		"Steps you already know (a form, a canvas gesture) are one actions call ending in read or screenshot, not one call per field, key or drag; when the result comes from a request, end with a wait for its text.",
		"Name fields and buttons by what a person reads (text); refs come from the latest read and expire when the page changes.",
		"wait is for a condition (a text, a selector, a URL), not a fixed sleep.",
		"Read with the page you already have, get_page_text or run_js; screenshots are for layout and canvas apps.",
		"In canvas editors (Excalidraw, tldraw) use the app's shortcuts and drags and check the screenshot, not its internals through run_js.",
		"Reuse your tab: tabs_create only when two pages must stay open, tabs_close when done.",
	].join(" ");

	/** One instance per connection: serveStdio builds it once the client's opening picks the era. */
	function buildServer(): McpServer {
		const server = new McpServer(
			{ name: CHANNEL.command, version: VERSION },
			{ instructions, requestState: { verify: prompts.codec.verify } },
		);

		function tool<Shape extends z.ZodRawShape>(
			name: string,
			config: { description: string; inputSchema: Shape },
			run: (args: z.infer<z.ZodObject<Shape>>, bridge: Bridge) => Promise<CallToolResult>,
		): void {
			server.registerTool(name, { description: config.description, inputSchema: toolInput(config.inputSchema) }, (args, ctx) =>
				prompts.handle(
					ctx,
					// Undefined on 2026 connections, which carry them per request instead.
					server.server.getClientCapabilities(),
					(track: Track) => run(args, (method, params, timeoutMs) => client.call(method, params, timeoutMs, track)),
				),
			);
		}

		/** The tab's summary as JSON, then the page when the extension sent one. */
		const loaded = ({ page, ...summary }: { page?: PageSnapshot }): Content[] =>
			text(page ? `${JSON.stringify(summary)}\n${formatSnapshot(page)}` : summary);

		// Shared by most tools, so every word here is paid for once per tool.
		const tabId = z.number().int().optional().describe("Default: your current tab");
		const readOption = z
			.union([z.boolean(), z.literal("interactive")])
			.optional()
			.describe("Return the page afterwards: true for elements and text, interactive for elements only");
		// A call that loads a URL returns the page: one that returned a title alone was followed by a wait and a read.
		const loadRead = z
			.union([z.boolean(), z.literal("interactive")])
			.optional()
			.describe("Default true. false: tabId, url and title only. interactive: elements without the text");

		tool(
			"list_connected_browsers",
			{
				description: "List the browsers with sitegeist running on this computer. Tabs belong to one browser; select_browser switches.",
				inputSchema: {},
			},
			async () => {
				try {
					if (!client.connected) await client.connect().catch(() => undefined);
					const browsers = await listBrowsers();
					return {
						content: text(
							browsers.map((b) => ({
								id: b.id,
								name: b.name,
								extensionConnected: b.extensionConnected,
								inUse: b.path === client.connectedPath,
							})),
						),
					};
				} catch (err) {
					return errorResult(err);
				}
			},
		);
		tool(
			"select_browser",
			{
				description: "Use another browser from now on, by the id or name from list_connected_browsers. Your tabs in the current browser stay open there.",
				inputSchema: { browser: z.string().describe("Id or name, e.g. Helium") },
			},
			async ({ browser }) => {
				try {
					const browsers = await listBrowsers();
					const wanted = browser.toLowerCase();
					const match = browsers.find((b) => b.id === browser) ?? browsers.find((b) => b.name?.toLowerCase().includes(wanted));
					if (!match) throw new Error(`No connected browser matches ${browser}`);
					client.close();
					client.preferred = match.path;
					client.preferredName = match.name;
					await client.connect(match.path);
					return { content: text({ selected: match.id, name: match.name }) };
				} catch (err) {
					return errorResult(err);
				}
			},
		);
		tool(
			"tabs_context",
			{
				description: "List your session's tabs. A new session has none: navigate opens the first.",
				inputSchema: {},
			},
			(_args, bridge) => call(bridge, "tabs.context"),
		);
		tool(
			"tabs_create",
			{
				description:
					"Open a URL in another background tab, make it current and return the page as navigate does. Only to keep a second page open; otherwise navigate.",
				inputSchema: { url: z.string().url(), read: loadRead },
			},
			async (args, bridge) => {
				try {
					return { content: loaded(await bridge("tabs.create", { ...args, read: args.read ?? true })) };
				} catch (err) {
					return errorResult(err);
				}
			},
		);
		tool(
			"tabs_close",
			{ description: "Close one of the session's tabs.", inputSchema: { tabId: z.number().int() } },
			(args, bridge) => call(bridge, "tabs.close", args),
		);
		tool(
			"tabs_select",
			{ description: "Make one of the session's tabs current without showing it to the user.", inputSchema: { tabId: z.number().int() } },
			(args, bridge) => call(bridge, "tabs.select", args),
		);
		tool(
			"tabs_show",
			{
				description: "Bring a tab in front of the user. Only when they asked to see it or must act themselves (login, captcha).",
				inputSchema: { tabId },
			},
			(args, bridge) => call(bridge, "tabs.show", args),
		);
		tool(
			"navigate",
			{
				description:
					"Load a URL in your current tab (the first call opens it), or 'back' / 'forward'. Waits until the page holds still and returns it: tabId, url, title (loading:true if it is still loading), elements with refs, and text. No wait or read_page is needed after it; if it still shows a placeholder, wait for the text you expect.",
				inputSchema: {
					url: z.string(),
					tabId,
					waitUntil: z.enum(["domcontentloaded", "load"]).optional(),
					read: loadRead,
				},
			},
			async (args, bridge) => {
				try {
					return { content: loaded(await bridge("navigate", { ...args, read: args.read ?? true })) };
				} catch (err) {
					return errorResult(err);
				}
			},
		);
		tool(
			"screenshot",
			{
				description:
					"JPEG of the tab's viewport (works while it is hidden). For layout and visual checks; reading is cheaper with read_page or get_page_text.",
				inputSchema: {
					tabId,
					fullPage: z.boolean().optional(),
					maxWidth: z.number().int().optional().describe("Width in pixels. Default: the viewport's CSS width, 1280 at most"),
				},
			},
			async (args, bridge) => {
				try {
					const shot = (await bridge("screenshot", args)) as {
						data: string;
						mimeType: string;
						width: number;
						height: number;
						cssWidth?: number;
						cssHeight?: number;
						imageId: string;
					};
					const note = "Give click/drag/hover/scroll x/y in this image's pixels; they are mapped to the page for you.";
					return {
						content: [
							{ type: "image", data: shot.data, mimeType: shot.mimeType },
							{ type: "text", text: `${shot.width}x${shot.height} screenshot, imageId ${shot.imageId}. ${note}` },
						],
					};
				} catch (err) {
					return errorResult(err);
				}
			},
		);
		tool(
			"read_page",
			{
				description:
					"The page as text: interactive elements with refs (e1, e2, ...) for click/type/fill, then its readable text (the first 3000 characters unless maxTextChars says otherwise).",
				inputSchema: {
					tabId,
					filter: z.enum(["all", "interactive"]).optional(),
					maxNodes: z.number().int().optional(),
					maxTextChars: z.number().int().optional(),
				},
			},
			async (args, bridge) => {
				try {
					const snap = (await bridge("snapshot", { ...args, maxTextChars: args.maxTextChars ?? 3000 })) as PageSnapshot;
					return { content: text(formatSnapshot(snap)) };
				} catch (err) {
					return errorResult(err);
				}
			},
		);
		tool(
			"get_page_text",
			{ description: "Readable text of the page or of a CSS selector.", inputSchema: { tabId, selector: z.string().optional(), maxChars: z.number().int().optional() } },
			(args, bridge) => call(bridge, "text", args),
		);
		tool(
			"get_page_html",
			{ description: "Outer HTML of the page or of a CSS selector.", inputSchema: { tabId, selector: z.string().optional(), maxChars: z.number().int().optional() } },
			(args, bridge) => call(bridge, "html", args),
		);
		tool(
			"find",
			{
				description:
					'Find elements by what you would call them ("search bar", "login button"); role words and common synonyms work. Returns refs for click/type/fill.',
				inputSchema: { query: z.string(), tabId, limit: z.number().int().optional() },
			},
			async (args, bridge) => {
				try {
					const found = (await bridge("find", args)) as { matches: SnapNode[]; dialogs?: unknown[] };
					if (found.matches.length === 0) return { content: text(`No elements match "${args.query}". Try read_page or other words.`) };
					return { content: text(formatNodes(found.matches, "") + dialogNote(found)) };
				} catch (err) {
					return errorResult(err);
				}
			},
		);
		const targetSchema = {
			tabId,
			ref: z.string().optional().describe("From read_page or find"),
			selector: z.string().optional().describe("CSS selector"),
			text: z.string().optional().describe("Its visible label, placeholder or button text"),
			x: z.number().optional().describe("Pixels of the latest screenshot"),
			y: z.number().optional(),
		};
		tool(
			"click",
			{
				description:
					"Click an element by ref, selector or text, or at x/y of the latest screenshot, with real input events. read:true returns the page once it holds still after the click.",
				inputSchema: {
					...targetSchema,
					button: z.enum(["left", "right", "middle"]).optional(),
					clickCount: z.number().int().optional(),
					read: readOption,
				},
			},
			async ({ read, ...args }, bridge) => {
				if (!read) return call(bridge, "click", args);
				try {
					// One step of actions: its read waits for the page to settle after the click.
					const done = (await bridge("actions", { steps: [{ click: args }], read, tabId: args.tabId })) as {
						page: PageSnapshot;
						dialogs?: unknown[];
					};
					return { content: text(`Clicked.${dialogNote(done)}\n${formatSnapshot(done.page)}`) };
				} catch (err) {
					return errorResult(err);
				}
			},
		);
		tool("hover", { description: "Move the mouse over an element.", inputSchema: targetSchema }, (args, bridge) => call(bridge, "hover", args));
		tool(
			"type",
			{
				description:
					"Type text with real key events, after clicking ref, selector or target when one is given. Long text is inserted at once; keys:true sends a key event per character, for editors that need it. submit presses Enter afterwards.",
				inputSchema: {
					text: z.string(),
					tabId,
					ref: z.string().optional(),
					selector: z.string().optional(),
					target: z.string().optional().describe("Visible label or placeholder of the field"),
					submit: z.boolean().optional(),
					keys: z.boolean().optional(),
				},
			},
			(args, bridge) => call(bridge, "type", args),
		);
		tool(
			"press",
			{
				description: "Press a key or chord: Enter, Escape, Tab, ArrowDown, Control+a, Meta+Shift+p ...",
				inputSchema: { key: z.string(), tabId, repeat: z.number().int().optional() },
			},
			(args, bridge) => call(bridge, "press", args),
		);
		tool(
			"list_downloads",
			{
				description:
					"Files that pages downloaded, newest first, with their absolute paths: use it after a click that saves a file. The user turns it on under Settings > Downloads in the side panel.",
				inputSchema: { limit: z.number().int().min(1).max(100).optional() },
			},
			(args, bridge) => call(bridge, "downloads.list", args),
		);
		tool(
			"handle_dialog",
			{
				description:
					"Choose the answer to the next confirm() or prompt(), before the action that opens it. Without it page dialogs are accepted at once, and each tool result lists the ones answered during the call.",
				inputSchema: {
					accept: z.boolean().describe("false dismisses (Cancel)"),
					promptText: z.string().optional().describe("Text to enter in a prompt()"),
					tabId,
				},
			},
			(args, bridge) => call(bridge, "dialog.next", args),
		);
		tool(
			"fill",
			{
				description:
					"Set the value of a form control (input, textarea, select, checkbox, contenteditable), named by ref, selector or text (its label or placeholder).",
				inputSchema: {
					value: z.string(),
					tabId,
					ref: z.string().optional(),
					selector: z.string().optional(),
					text: z.string().optional(),
				},
			},
			(args, bridge) => call(bridge, "fill", args),
		);
		tool(
			"scroll",
			{
				description: "Scroll the page by dx/dy, to top/bottom, or to an element (ref/selector).",
				inputSchema: {
					tabId,
					dx: z.number().optional(),
					dy: z.number().optional(),
					to: z.enum(["top", "bottom"]).optional(),
					ref: z.string().optional(),
					selector: z.string().optional(),
				},
			},
			(args, bridge) => call(bridge, "scroll", args),
		);
		tool(
			"drag",
			{
				description: "Drag the mouse between two points of the latest screenshot (draw shapes, move items, connect arrows).",
				inputSchema: { tabId, from: z.object({ x: z.number(), y: z.number() }), to: z.object({ x: z.number(), y: z.number() }) },
			},
			(args, bridge) => call(bridge, "drag", args),
		);
		tool(
			"actions",
			{
				description:
					"Run several steps in one call, then read the page or screenshot it. " +
					'A form: steps [{"fill":{"text":"Name","value":"Ada"}},{"click":{"text":"Send"}}], read true. ' +
					'A canvas: steps [{"press":"r"},{"drag":{"from":{"x":200,"y":200},"to":{"x":360,"y":300}}},{"type":"Start"}], screenshot true. ' +
					"Steps: navigate (url), fill ({ref|selector|text, value}), click ({ref|selector|text} or {x,y}, clickCount), doubleClick ({x,y}), drag ({from,to}), type (text), press (key or chord), hover, scroll ({dx,dy}|{to}), wait (ms, or {selector|text|urlIncludes}). " +
					"x/y are pixels of the latest screenshot. Stops at the first failing step. When the result arrives after a request, end with a wait for its text.",
				inputSchema: {
					steps: z.array(z.record(z.string(), z.any())).min(1).max(40),
					screenshot: z.boolean().optional().describe("Screenshot after the last step"),
					read: readOption,
					settleMs: z.number().int().optional().describe("Pause between steps in ms (default 80)"),
					tabId,
				},
			},
			async (args, bridge) => {
				try {
					const res = (await bridge("actions", args)) as {
						steps: number;
						screenshot?: { data: string; mimeType: string; width: number; height: number };
						page?: PageSnapshot;
						dialogs?: unknown[];
					};
					const content: Content[] = [{ type: "text", text: `${res.steps} steps done.${dialogNote(res)}` }];
					if (res.page) content.push({ type: "text", text: formatSnapshot(res.page) });
					if (res.screenshot) {
						content.unshift({ type: "image", data: res.screenshot.data, mimeType: res.screenshot.mimeType });
						content.push({
							type: "text",
							text: `${res.screenshot.width}x${res.screenshot.height} screenshot. Give x/y in this image's pixels.`,
						});
					}
					return { content };
				} catch (err) {
					return errorResult(err);
				}
			},
		);
		tool(
			"run_js",
			{
				description:
					"Run JavaScript in the page and return its JSON value. code is one expression (a promise is awaited); wrap statements in an IIFE: (() => { const a = 1; return a; })(). world user (default) is an isolated world with DOM access, main sees the page's own globals. frame runs it in a cross-origin iframe (embedded checkout, editor, consent dialog) whose URL contains that text; the error lists the frames when none matches. skill loads that skill's helper library first.",
				inputSchema: {
					code: z.string(),
					tabId,
					world: z.enum(["user", "main"]).optional(),
					frame: z.string().optional(),
					skill: z.string().optional(),
				},
			},
			async (args, bridge) => {
				const res = await call(bridge, "evaluate", args);
				const first = res.content[0];
				if (res.isError && first?.type === "text" && STATEMENT_ERROR.test(first.text)) first.text += `\n${STATEMENT_HINT}`;
				return res;
			},
		);
		tool(
			"cdp",
			{
				description:
					"Send a raw Chrome DevTools Protocol command to your tab and return its result, for what no other tool does (Emulation.setGeolocationOverride, Network.setExtraHTTPHeaders, Page.printToPDF, Performance.getMetrics). The tab is attached; enable a domain first if the command needs it. Events are not streamed: use read_console and read_network. Commands that reach other tabs or browser-wide state are refused when the user asks to approve new sites.",
				inputSchema: {
					method: z.string().describe("e.g. Emulation.setDeviceMetricsOverride"),
					params: z.record(z.string(), z.unknown()).optional(),
					tabId,
				},
			},
			async (args, bridge) => {
				const res = await call(bridge, "cdp", args);
				const first = res.content[0];
				if (!res.isError && first?.type === "text" && first.text.length > CDP_RESULT_MAX_CHARS) {
					first.text = `${first.text.slice(0, CDP_RESULT_MAX_CHARS)}\n[truncated: ${first.text.length} chars total; narrow the command (depth, selectors, clip)]`;
				}
				return res;
			},
		);
		tool(
			"wait",
			{
				description:
					"Wait until a selector, a text or a URL fragment appears (timeoutMs, default 10000), or for a fixed ms. navigate and read:true already wait until the page holds still; for content that a request brings later, wait for its text, not for a fixed time.",
				inputSchema: {
					tabId,
					selector: z.string().optional(),
					text: z.string().optional(),
					urlIncludes: z.string().optional(),
					ms: z.number().int().optional(),
					timeoutMs: z.number().int().optional(),
				},
			},
			(args, bridge) => call(bridge, "wait", args),
		);
		tool(
			"file_upload",
			{
				description:
					"Attach local files to the page. With no target they go to the page's file input, hidden ones included; or name a file input, its label, an upload button or a drop zone by ref, selector or text, or a drop point by x/y. Never click an upload button yourself: name it here. Upload buttons, and more than 25 MB per call, need sitegeist's \"Allow access to file URLs\".",
				inputSchema: { paths: z.array(z.string()).min(1).describe("Absolute paths"), ...targetSchema },
			},
			async ({ paths, ...where }, bridge) => {
				try {
					const absolute = paths.map((p) => resolve(p));
					// An extension from before upload.paths answers "Unknown method": use the chunked path.
					const direct = (await bridge("upload.paths", { paths: absolute, ...where }).catch((err: unknown) => {
						if (/Unknown method/.test(err instanceof Error ? err.message : String(err))) return { fallback: true };
						throw err;
					})) as { fallback?: boolean };
					if (!direct.fallback) return { content: text(direct) };
					let total = 0;
					for (const path of paths) total += statSync(path).size;
					if (total > MAX_UPLOAD_BYTES) throw new Error(`The files are ${Math.round(total / 1048576)} MB; at most 25 MB per call`);
					const files = [];
					for (const [index, path] of paths.entries()) {
						const uploadId = `${process.pid}-${Date.now()}-${index}`;
						const data = readFileSync(path).toString("base64");
						for (let at = 0; at < data.length || at === 0; at += UPLOAD_CHUNK_CHARS) {
							const chunk = data.slice(at, at + UPLOAD_CHUNK_CHARS) || " ";
							await bridge("upload.chunk", { uploadId, offset: at, data: chunk });
						}
						files.push({
							uploadId,
							name: basename(path),
							mimeType: MIME_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream",
						});
					}
					return { content: text(await bridge("upload.commit", { files, ...where })) };
				} catch (err) {
					return errorResult(err);
				}
			},
		);
		tool(
			"upload_image",
			{
				description:
					"Send a screenshot you took (its imageId) to a file input or drop target, named as in file_upload. tabId may be another of your tabs.",
				inputSchema: { imageId: z.string(), filename: z.string().optional(), ...targetSchema },
			},
			(args, bridge) => call(bridge, "upload.image", args),
		);
		tool(
			"skills_list",
			{
				description:
					"List the skills saved in the browser: instructions and helper code for sites, recorded workflows included. navigate says when a page has one; url narrows the list to that page.",
				inputSchema: { url: z.string().optional() },
			},
			(args, bridge) => call(bridge, "skills.list", args),
		);
		tool(
			"skill_get",
			{
				description: "Read a skill: what it does, how to use it, examples. Run its helpers with run_js and skill set to its name.",
				inputSchema: { name: z.string(), includeLibrary: z.boolean().optional().describe("Include the helper code itself") },
			},
			(args, bridge) => call(bridge, "skills.get", args),
		);
		tool(
			"prompts_list",
			{ description: "List the prompts the user saved in the browser, to run one when they refer to it by name.", inputSchema: {} },
			(_args, bridge) => call(bridge, "prompts.list"),
		);
		tool(
			"resize_window",
			{
				description:
					"Render your tab at another size, to test a layout: a preset (mobile, tablet, desktop) or width and height in CSS pixels. Tabs render at 1280x800 by default; desktop goes back to that.",
				inputSchema: {
					preset: z.enum(["mobile", "tablet", "desktop"]).optional(),
					width: z.number().int().optional(),
					height: z.number().int().optional(),
					tabId,
				},
			},
			(args, bridge) => call(bridge, "window.resize", args),
		);
		tool(
			"record_video",
			{
				description:
					"Record the tab as an MP4 (Chrome 153+, hidden tabs included): start, do the steps, then stop, which writes the file and returns its path. gif_creator makes an annotated GIF instead.",
				inputSchema: {
					action: z.enum(["start", "stop"]),
					path: z.string().optional().describe("For stop: the file to write. Default: recording-<time>.mp4 in the working directory"),
					frameRate: z.number().int().min(1).max(60).optional(),
					maxWidth: z.number().int().min(100).max(4096).optional(),
					tabId,
				},
			},
			async ({ path, ...args }, bridge) => {
				try {
					const result = (await bridge("video", args, 120000)) as { data?: string; bytes?: number };
					if (args.action !== "stop" || !result.data) return { content: text(result) };
					const file = resolve(path ?? `recording-${Date.now()}.mp4`);
					writeFileSync(file, Buffer.from(result.data, "base64"));
					return { content: text({ path: file, bytes: result.bytes, mimeType: "video/mp4" }) };
				} catch (err) {
					return errorResult(err);
				}
			},
		);
		tool(
			"gif_creator",
			{
				description:
					"Record your tab as an animated GIF with click markers, drag arrows, action labels and a progress bar, to show how something works. start_recording, do the steps, then export (it stops by itself). The recording shows everything on screen, logged-in details too, so review it before sharing.",
				inputSchema: {
					action: z.enum(["start_recording", "stop_recording", "export", "clear"]),
					path: z.string().optional().describe("For export: the file to write. Default: recording-<time>.gif in the working directory"),
					options: z
						.object({
							maxWidth: z.number().int().optional().describe("Pixels (default 800)"),
							showClickIndicators: z.boolean().optional(),
							showDragPaths: z.boolean().optional(),
							showActionLabels: z.boolean().optional(),
							showProgressBar: z.boolean().optional(),
							quality: z.number().int().min(1).max(30).optional().describe("Lower is better and larger (default 10)"),
						})
						.optional(),
					tabId,
				},
			},
			async ({ path, ...args }, bridge) => {
				try {
					const result = (await bridge("gif", args, 300000)) as { data?: string; width?: number; height?: number; frames?: number; bytes?: number };
					if (args.action !== "export" || !result.data) return { content: text(result) };
					const file = resolve(path ?? `recording-${Date.now()}.gif`);
					writeFileSync(file, Buffer.from(result.data, "base64"));
					const { data: _data, ...summary } = result;
					return { content: text({ path: file, ...summary }) };
				} catch (err) {
					return errorResult(err);
				}
			},
		);
		tool(
			"fill_login",
			{
				description:
					"Fill the sign-in form on your page from the user's 1Password, instead of asking them for a password: they approve it in 1Password and you never see it. It fills what the page shows (username, password or one-time code); press the sign-in button yourself. Several logins for the site come back as a list: call again with item set to one id.",
				inputSchema: { item: z.string().optional(), tabId },
			},
			(args, bridge) => call(bridge, "login.fill", args),
		);
		tool(
			"notify_user",
			{
				description:
					"Show the user a desktop notification when they must act (a login, a captcha, a decision); clicking it opens your tab. Pair it with tabs_show. Does nothing if they have notifications off.",
				inputSchema: { title: z.string(), message: z.string().optional(), tabId },
			},
			(args, bridge) => call(bridge, "notify", args),
		);
		tool(
			"read_console",
			{
				description: "Console messages captured on the tab since capture started (first call starts capture).",
				inputSchema: { tabId, onlyErrors: z.boolean().optional(), pattern: z.string().optional(), clear: z.boolean().optional(), limit: z.number().int().optional() },
			},
			(args, bridge) => call(bridge, "console.read", args),
		);
		tool(
			"read_network",
			{
				description:
					"Network requests captured on the tab since capture started (first call starts capture). body:true adds each text response body (JSON, HTML, scripts), so you can read an API response instead of the rendered page; narrow with urlPattern.",
				inputSchema: {
					tabId,
					urlPattern: z.string().optional(),
					clear: z.boolean().optional(),
					limit: z.number().int().optional(),
					body: z.boolean().optional(),
					bodyChars: z.number().int().optional().describe("Characters per body (default 20000)"),
				},
			},
			(args, bridge) => call(bridge, "network.read", args),
		);

		// stdin closed: the harness is gone, and the bridge socket would keep the process alive.
		server.server.onclose = () => client.close();
		return server;
	}

	serveStdio(buildServer, {
		onerror: (err) => process.stderr.write(`[sitegeist] ${err.message}\n`),
	});
	// Connect lazily on the first call, but try once now so a missing extension is reported early.
	client.connect().catch((err) => process.stderr.write(`[sitegeist] ${err instanceof Error ? err.message : String(err)}\n`));
}
