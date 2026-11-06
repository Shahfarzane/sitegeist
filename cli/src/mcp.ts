/**
 * `sitegeist mcp`: stdio MCP server that exposes the browser bridge to any MCP
 * client (Claude Code, Codex, omp, ...). Tool names mirror Claude in Chrome so
 * prompts written for it carry over.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, resolve } from "node:path";
import { z } from "zod";
import { BridgeClient, BridgeRpcError, listBrowsers } from "./client.ts";
import { install, isInstalled } from "./install.ts";
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

/** read_page as compact text: a fraction of the tokens of pretty JSON, same information. */
function formatSnapshot(snap: {
	url: string;
	title: string;
	viewport: { width: number; height: number; scrollY: number; pageHeight: number };
	nodes: SnapNode[];
	text: string;
}): string {
	const v = snap.viewport;
	const parts = [
		`Page: ${snap.title} | ${snap.url}`,
		`Viewport ${v.width}x${v.height}, scrollY ${v.scrollY} of ${v.pageHeight}`,
		`Elements (${snap.nodes.length}; use the ref with click/type/fill/scroll):`,
		formatNodes(snap.nodes, snap.url),
	];
	if (snap.text) parts.push("", "Text:", snap.text);
	return parts.join("\n");
}

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

	const server = new McpServer(
		{ name: "sitegeist", version: VERSION },
		{
			instructions: [
				"sitegeist drives the user's real Chromium browser in the background.",
				"You get your own tab group; your tabs never take focus and you cannot see the user's other tabs.",
				"Every tool call is a full model turn, so do as much as you can per call.",
				"Workflow: navigate with read:true (the page comes back in the same call), then actions for everything you already know: fill fields, click, type, with read:true or screenshot:true to see the result in that same call.",
				"Fields and buttons can be named by what a person reads (text), so a form you can describe needs no read_page first.",
				"For canvas apps and multi-step input, batch steps with actions (one call, screenshot at the end) instead of one tool call per key or drag.",
				"Canvas editors (Excalidraw, tldraw, Figma-like): use the app's keyboard shortcuts and mouse drags, check the result on the screenshot, and do not reverse-engineer the app's internals with run_js.",
				"Reuse your current tab for step-by-step browsing; tabs_create only when two pages must stay open.",
				"Close tabs you no longer need with tabs_close. Prefer read_page/get_page_text over screenshots for reading.",
				"Refs expire when the page changes; take a new read_page after navigation or big updates.",
			].join(" "),
		},
	);
	const client = new BridgeClient({
		name: harnessName(),
		session: sessionKey(),
		onEvent: (event, data) => {
			if (event === "permission_request") void handlePermission(data);
		},
	});

	async function handlePermission(data: Record<string, unknown>): Promise<void> {
		const requestId = String(data.requestId);
		const host = String(data.host);
		let decision: "allow_once" | "allow_host" | "deny" = "deny";
		if (process.env.SITEGEIST_AUTO_ALLOW === "1") {
			await client.call("permission.respond", { requestId, decision: "allow_once" }).catch(() => undefined);
			return;
		}
		try {
			const answer = await server.server.elicitInput({
				message: `sitegeist: the browser agent wants to open ${host}. Allow?`,
				requestedSchema: {
					type: "object",
					properties: {
						decision: {
							type: "string",
							title: "Decision",
							enum: ["allow_host", "allow_once", "deny"],
							enumNames: [`Allow ${host} from now on`, "Allow once", "Deny"],
						},
					},
					required: ["decision"],
				},
			});
			if (answer.action === "accept") {
				const d = (answer.content as { decision?: string } | undefined)?.decision;
				if (d === "allow_host" || d === "allow_once" || d === "deny") decision = d;
			}
		} catch {
			// Client without elicitation support (headless runs): deny now instead of stalling
			// the tool call; the error text tells the model how the user can allow the host.
			process.stderr.write(
				`[sitegeist] ${host} needs approval: run \`sitegeist allow ${host}\`, use the side panel (Settings > Bridge), or set SITEGEIST_AUTO_ALLOW=1.\n`,
			);
		}
		await client.call("permission.respond", { requestId, decision }).catch(() => undefined);
	}

	function errorResult(err: unknown): { content: Content[]; isError: true } {
		const message = err instanceof BridgeRpcError ? `${err.rpc.code}: ${err.rpc.message}` : err instanceof Error ? err.message : String(err);
		return { content: text(message), isError: true };
	}

	async function call(method: string, params: Record<string, unknown> = {}): Promise<{ content: Content[]; isError?: boolean }> {
		try {
			const result = await client.call(method, params);
			return { content: text(result) };
		} catch (err) {
			return errorResult(err);
		}
	}

	const tabId = z.number().int().optional().describe("Tab to act on; defaults to the session's current tab");
	const readOption = z
		.union([z.boolean(), z.literal("interactive")])
		.optional()
		.describe("Also return the page: true for elements and text, interactive for elements only");

	server.registerTool(
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
	server.registerTool(
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
				await client.connect(match.path);
				return { content: text({ selected: match.id, name: match.name }) };
			} catch (err) {
				return errorResult(err);
			}
		},
	);
	server.registerTool(
		"tabs_context",
		{
			description:
				"List the tabs in your session's own tab group (background tabs, separate from the user's). A new session has none: navigate opens the first one.",
			inputSchema: {},
		},
		() => call("tabs.context"),
	);
	server.registerTool(
		"tabs_create",
		{
			description:
				"Open a URL in an additional background tab in your group and make it current. Only for keeping a second page open; for normal browsing use navigate.",
			inputSchema: { url: z.string().url() },
		},
		(args) => call("tabs.create", args),
	);
	server.registerTool(
		"tabs_close",
		{ description: "Close one of the session's tabs.", inputSchema: { tabId: z.number().int() } },
		(args) => call("tabs.close", args),
	);
	server.registerTool(
		"tabs_select",
		{ description: "Make one of the session's tabs current without showing it to the user.", inputSchema: { tabId: z.number().int() } },
		(args) => call("tabs.select", args),
	);
	server.registerTool(
		"tabs_show",
		{
			description: "Bring a tab in front of the user. Only when they asked to see it or must act themselves (login, captcha).",
			inputSchema: { tabId },
		},
		(args) => call("tabs.show", args),
	);
	server.registerTool(
		"navigate",
		{
			description:
				"Load a URL in your current tab (the first call opens your tab), or 'back' / 'forward'. Waits for the page; the result has tabId, url, title, and loading:true if it is still loading. read:true also returns the page (elements with refs and text), saving a read_page call.",
			inputSchema: {
				url: z.string(),
				tabId,
				waitUntil: z.enum(["domcontentloaded", "load"]).optional(),
				read: readOption,
			},
		},
		async (args) => {
			try {
				const { page, ...summary } = (await client.call("navigate", args)) as { page?: Parameters<typeof formatSnapshot>[0] };
				return { content: text(page ? `${JSON.stringify(summary)}\n${formatSnapshot(page)}` : summary) };
			} catch (err) {
				return errorResult(err);
			}
		},
	);
	server.registerTool(
		"screenshot",
		{
			description:
				"JPEG screenshot of the current tab's viewport (works while it is hidden). For layout and visual checks; read_page / get_page_text are faster and cheaper for reading.",
			inputSchema: {
				tabId,
				fullPage: z.boolean().optional(),
				maxWidth: z
					.number()
					.int()
					.optional()
					.describe("Image width in pixels. Default: the viewport's CSS width (max 1280), so image x/y can be clicked directly"),
			},
		},
		async (args) => {
			try {
				const shot = (await client.call("screenshot", args)) as {
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
	server.registerTool(
		"read_page",
		{
			description:
				"Compact snapshot of the page: interactive elements with refs (e1, e2, ...) and coordinates, plus readable text. Use refs with click/type/fill.",
			inputSchema: {
				tabId,
				filter: z.enum(["all", "interactive"]).optional(),
				maxNodes: z.number().int().optional(),
				maxTextChars: z.number().int().optional(),
			},
		},
		async (args) => {
			try {
				const snap = (await client.call("snapshot", { ...args, maxTextChars: args.maxTextChars ?? 3000 })) as Parameters<typeof formatSnapshot>[0];
				return { content: text(formatSnapshot(snap)) };
			} catch (err) {
				return errorResult(err);
			}
		},
	);
	server.registerTool(
		"get_page_text",
		{ description: "Readable text of the page or of a CSS selector.", inputSchema: { tabId, selector: z.string().optional(), maxChars: z.number().int().optional() } },
		(args) => call("text", args),
	);
	server.registerTool(
		"get_page_html",
		{ description: "Outer HTML of the page or of a CSS selector.", inputSchema: { tabId, selector: z.string().optional(), maxChars: z.number().int().optional() } },
		(args) => call("html", args),
	);
	server.registerTool(
		"find",
		{
			description:
				'Find elements by what you would call them: "search bar", "login button", "add to cart". Role words and common synonyms are understood. Returns refs for click/type/fill.',
			inputSchema: { query: z.string(), tabId, limit: z.number().int().optional() },
		},
		async (args) => {
			try {
				const found = (await client.call("find", args)) as { matches: SnapNode[] };
				if (found.matches.length === 0) return { content: text(`No elements match "${args.query}". Try read_page or other words.`) };
				return { content: text(formatNodes(found.matches, "")) };
			} catch (err) {
				return errorResult(err);
			}
		},
	);
	const targetSchema = {
		tabId,
		ref: z.string().optional().describe("Element ref from read_page or find"),
		selector: z.string().optional().describe("CSS selector"),
		text: z.string().optional().describe("What a person reads on it: a label, placeholder, or button text"),
		x: z.number().optional().describe("Pixel x in the latest screenshot"),
		y: z.number().optional().describe("Pixel y in the latest screenshot"),
	};
	server.registerTool(
		"click",
		{
			description: "Click an element by ref, selector or text, or at x/y pixels of the latest screenshot, with real input events.",
			inputSchema: { ...targetSchema, button: z.enum(["left", "right", "middle"]).optional(), clickCount: z.number().int().optional() },
		},
		(args) => call("click", args),
	);
	server.registerTool("hover", { description: "Move the mouse over an element.", inputSchema: targetSchema }, (args) => call("hover", args));
	server.registerTool(
		"type",
		{
			description:
				"Type text with real key events (long text goes into a text field in one insertion). Clicks the target first when ref, selector or target (visible text) is given. submit presses Enter afterwards.",
			inputSchema: {
				text: z.string(),
				tabId,
				ref: z.string().optional(),
				selector: z.string().optional(),
				target: z.string().optional().describe("Label, placeholder or visible text of the field to click first"),
				submit: z.boolean().optional(),
			},
		},
		(args) => call("type", args),
	);
	server.registerTool(
		"press",
		{
			description: "Press a key or chord: Enter, Escape, Tab, ArrowDown, Control+a, Meta+Shift+p ...",
			inputSchema: { key: z.string(), tabId, repeat: z.number().int().optional() },
		},
		(args) => call("press", args),
	);
	server.registerTool(
		"fill",
		{
			description: "Set a form control's value directly (inputs, textareas, selects, checkboxes, contenteditable). Name it by ref, selector or text (its label or placeholder).",
			inputSchema: {
				value: z.string(),
				tabId,
				ref: z.string().optional(),
				selector: z.string().optional(),
				text: z.string().optional().describe("Label or placeholder of the field"),
			},
		},
		(args) => call("fill", args),
	);
	server.registerTool(
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
		(args) => call("scroll", args),
	);
	server.registerTool(
		"drag",
		{
			description: "Drag with the mouse between two points given in the latest screenshot's pixels (draw shapes, move items, connect arrows).",
			inputSchema: { tabId, from: z.object({ x: z.number(), y: z.number() }), to: z.object({ x: z.number(), y: z.number() }) },
		},
		(args) => call("drag", args),
	);
	server.registerTool(
		"actions",
		{
			description:
				"Run several steps in one call, then optionally read the page or screenshot. Use it for anything you already know how to do: " +
				'a form is one call, e.g. steps [{"fill":{"text":"Name","value":"Ada"}},{"fill":{"text":"Plan","value":"Pro"}},{"click":{"text":"Send"}}], read true. ' +
				'A canvas: steps [{"press":"r"},{"drag":{"from":{"x":200,"y":200},"to":{"x":360,"y":300}}},{"press":"Enter"},{"type":"Start"},{"press":"Escape"}], screenshot true. ' +
				"Step kinds: navigate (url), fill ({ref|selector|text, value}), press (key or chord), click ({x,y} | {ref} | {selector} | {text}, optional clickCount), doubleClick ({x,y}), drag ({from,to}), type (text), hover ({x,y}|{ref}), scroll ({dx,dy}|{to}), wait (ms, or {selector|text|urlIncludes}). " +
				"x/y are pixels of the latest screenshot. Steps are spaced by settleMs (default 80) so the app can react. Stops at the first failing step.",
			inputSchema: {
				steps: z.array(z.record(z.string(), z.any())).min(1).max(40),
				screenshot: z.boolean().optional().describe("Return a screenshot after the last step"),
				read: readOption,
				settleMs: z.number().int().optional().describe("Pause between steps in ms (default 80)"),
				tabId,
			},
		},
		async (args) => {
			try {
				const res = (await client.call("actions", args)) as {
					steps: number;
					screenshot?: { data: string; mimeType: string; width: number; height: number };
					page?: Parameters<typeof formatSnapshot>[0];
				};
				const content: Content[] = [{ type: "text", text: `${res.steps} steps done.` }];
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
	server.registerTool(
		"run_js",
		{
			description:
				"Run JavaScript in the page and return its JSON value. world=user (default) is an isolated world with DOM access; world=main sees the page's own globals. skill loads a skill's library first, so its helpers are there for your code.",
			inputSchema: {
				code: z.string(),
				tabId,
				world: z.enum(["user", "main"]).optional(),
				skill: z.string().optional().describe("Name of a skill whose library to load first"),
			},
		},
		(args) => call("evaluate", args),
	);
	server.registerTool(
		"cdp",
		{
			description:
				"Send a raw Chrome DevTools Protocol command to your current tab and return its result (e.g. Emulation.setGeolocationOverride, Network.setExtraHTTPHeaders, Page.printToPDF, DOM.getDocument, Performance.getMetrics, Input.dispatchMouseEvent). The tab is already attached; enable domains first if a command needs it. If the user turned on asking for new sites, commands that reach other tabs or browser-wide state are refused. Events are not streamed: use read_console and read_network. Prefer the dedicated tools when one fits.",
			inputSchema: {
				method: z.string().describe("CDP method, e.g. Emulation.setDeviceMetricsOverride"),
				params: z.record(z.string(), z.unknown()).optional().describe("Command parameters as in the CDP docs"),
				tabId,
			},
		},
		async (args) => {
			const res = await call("cdp", args);
			const first = res.content[0];
			if (!res.isError && first?.type === "text" && first.text.length > CDP_RESULT_MAX_CHARS) {
				first.text = `${first.text.slice(0, CDP_RESULT_MAX_CHARS)}\n[truncated: ${first.text.length} chars total; narrow the command (depth, selectors, clip)]`;
			}
			return res;
		},
	);
	server.registerTool(
		"wait",
		{
			description: "Wait for a selector, text, URL fragment, or a fixed number of milliseconds.",
			inputSchema: {
				tabId,
				selector: z.string().optional(),
				text: z.string().optional(),
				urlIncludes: z.string().optional(),
				ms: z.number().int().optional(),
				timeoutMs: z.number().int().optional(),
			},
		},
		(args) => call("wait", args),
	);
	server.registerTool(
		"file_upload",
		{
			description:
				"Attach local files to the page. Do not click upload buttons: that opens a native picker you cannot use. Without a target this fills the page's file input, hidden ones included. Name a file input, its label, or a drop zone with ref, selector or text; or give x/y for a drop target. 25 MB per call.",
			inputSchema: { paths: z.array(z.string()).min(1).describe("Absolute paths of local files"), ...targetSchema },
		},
		async ({ paths, ...where }) => {
			try {
				let total = 0;
				for (const path of paths) total += statSync(path).size;
				if (total > MAX_UPLOAD_BYTES) throw new Error(`The files are ${Math.round(total / 1048576)} MB; at most 25 MB per call`);
				const files = [];
				for (const [index, path] of paths.entries()) {
					const uploadId = `${process.pid}-${Date.now()}-${index}`;
					const data = readFileSync(path).toString("base64");
					for (let at = 0; at < data.length || at === 0; at += UPLOAD_CHUNK_CHARS) {
						await client.call("upload.chunk", { uploadId, data: data.slice(at, at + UPLOAD_CHUNK_CHARS) || " " });
					}
					files.push({
						uploadId,
						name: basename(path),
						mimeType: MIME_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream",
					});
				}
				return { content: text(await client.call("upload.commit", { files, ...where })) };
			} catch (err) {
				return errorResult(err);
			}
		},
	);
	server.registerTool(
		"upload_image",
		{
			description:
				"Send a screenshot you took (its imageId) to a file input or drop target, e.g. a bug report or a document. Target as in file_upload; tabId may be another of your tabs.",
			inputSchema: { imageId: z.string(), filename: z.string().optional(), ...targetSchema },
		},
		(args) => call("upload.image", args),
	);
	server.registerTool(
		"skills_list",
		{
			description:
				"List the skills saved in the browser: ready-made instructions and helper code for sites, recorded workflows included. navigate tells you when a page has one. Give url to see what applies there.",
			inputSchema: { url: z.string().optional() },
		},
		(args) => call("skills.list", args),
	);
	server.registerTool(
		"skill_get",
		{
			description: "Read a skill: what it does, how to use it, examples. Run its helpers with run_js and skill set to its name.",
			inputSchema: { name: z.string(), includeLibrary: z.boolean().optional().describe("Include the helper code itself") },
		},
		(args) => call("skills.get", args),
	);
	server.registerTool(
		"prompts_list",
		{ description: "List the prompts the user saved in the browser, to run one when they refer to it by name.", inputSchema: {} },
		() => call("prompts.list"),
	);
	server.registerTool(
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
		(args) => call("window.resize", args),
	);
	server.registerTool(
		"gif_creator",
		{
			description:
				"Record your tab as an animated GIF with click markers, drag arrows, action labels and a progress bar, to show how something works. start_recording, do the steps, then export (it stops by itself). The recording shows everything on screen, logged-in details too, so review it before sharing.",
			inputSchema: {
				action: z.enum(["start_recording", "stop_recording", "export", "clear"]),
				path: z.string().optional().describe("For export: where to write the file. Default: recording-<time>.gif in the working directory"),
				options: z
					.object({
						maxWidth: z.number().int().optional().describe("Output width in pixels (default 800)"),
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
		async ({ path, ...args }) => {
			try {
				const result = (await client.call("gif", args, 300000)) as { data?: string; width?: number; height?: number; frames?: number; bytes?: number };
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
	server.registerTool(
		"fill_login",
		{
			description:
				"Fill the sign-in form on your current page from the user's 1Password. They approve it in 1Password; you never see the password. Works per step: a page with only a username field gets that, a one-time-code page gets the code. Then press the sign-in button yourself. Several logins for the site come back as a list; call again with item set to one id. Use this instead of asking the user for a password.",
			inputSchema: { item: z.string().optional().describe("Id of a login from an earlier list"), tabId },
		},
		(args) => call("login.fill", args),
	);
	server.registerTool(
		"notify_user",
		{
			description:
				"Show the user a desktop notification when they must act: a login, a captcha, a decision. Pair it with tabs_show. Clicking it opens your tab. Does nothing if the user has notifications off.",
			inputSchema: { title: z.string(), message: z.string().optional(), tabId },
		},
		(args) => call("notify", args),
	);
	server.registerTool(
		"read_console",
		{
			description: "Console messages captured on the tab since capture started (first call starts capture).",
			inputSchema: { tabId, onlyErrors: z.boolean().optional(), pattern: z.string().optional(), clear: z.boolean().optional(), limit: z.number().int().optional() },
		},
		(args) => call("console.read", args),
	);
	server.registerTool(
		"read_network",
		{
			description: "Network requests captured on the tab since capture started (first call starts capture).",
			inputSchema: { tabId, urlPattern: z.string().optional(), clear: z.boolean().optional(), limit: z.number().int().optional() },
		},
		(args) => call("network.read", args),
	);

	const transport = new StdioServerTransport();
	await server.connect(transport);
	// Connect lazily on the first call, but try once now so a missing extension is reported early.
	client.connect().catch((err) => process.stderr.write(`[sitegeist] ${err instanceof Error ? err.message : String(err)}\n`));
}
