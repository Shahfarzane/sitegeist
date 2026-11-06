/**
 * Bridge method handlers. Each runs against one BrowserSession (one per connected
 * harness) and uses the same primitives as the sidepanel tools. Nothing here
 * changes the active tab except `tabs.show`.
 */

import {
	AGENT_VIEWPORT,
	captureScreenshot,
	scroll as cdpScroll,
	cdpSend,
	click,
	consoleEntries,
	drag,
	enableConsoleCapture,
	enableNetworkCapture,
	evaluateMain,
	hover,
	networkEntries,
	pressKey,
	screenshotToCss,
	setAgentViewport,
	startScreencast,
	stopScreencast,
	typeText,
	type ViewportSize,
} from "../browser/cdp.js";
import { rankNodes } from "../browser/find.js";
import { injectScript } from "../browser/inject.js";
import {
	deliverFiles,
	type ElementTarget,
	fillElement,
	goBack,
	goForward,
	locate,
	navigateTabDetailed,
	type PageFile,
	pageHtml,
	pageText,
	runInPage,
	type Snapshot,
	scrollPage,
	snapshot,
	waitFor,
	waitForLoad,
} from "../browser/page.js";
import type { BrowserSession } from "../browser/session.js";
import { fillLogin } from "../credentials/login.js";
import { showNotification } from "../notify/notifications.js";
import { type GifAction, gifRecorderFor, noteGifAction } from "../recording/gif-recorder.js";
import type { GifOptions } from "../recording/gif-types.js";
import { readStore } from "../storage/raw-store.js";
import { ANY_SITE, matchesAnyPattern } from "../storage/skill-match.js";
import type { SavedPrompt } from "../storage/stores/prompts-store.js";
import type { Skill } from "../storage/stores/skills-store.js";
import { getPermissionMode } from "./permissions.js";
import { ERR, type RpcError } from "./protocol.js";

export class BridgeError extends Error {
	constructor(
		readonly code: string,
		message: string,
	) {
		super(message);
	}
	toRpc(): RpcError {
		return { code: this.code, message: this.message };
	}
}

type Params = Record<string, unknown>;

export interface HandlerContext {
	session: BrowserSession;
	/** Ask before a navigation to a host that is not allowed yet; throws when denied. */
	checkUrl(url: string): Promise<void>;
	/** Stable id of the calling client. */
	clientId: string;
	/** Push an event to the calling client only. */
	emit(event: string, data: Record<string, unknown>): void;
}

type Handler = (ctx: HandlerContext, params: Params) => Promise<unknown>;

function num(params: Params, key: string): number | undefined {
	const v = params[key];
	if (v === undefined || v === null) return undefined;
	const n = Number(v);
	if (!Number.isFinite(n)) throw new BridgeError(ERR.BAD_PARAMS, `${key} must be a number`);
	return n;
}

function str(params: Params, key: string): string | undefined {
	const v = params[key];
	if (v === undefined || v === null) return undefined;
	return String(v);
}

function requireStr(params: Params, key: string): string {
	const v = str(params, key);
	if (!v) throw new BridgeError(ERR.BAD_PARAMS, `${key} is required`);
	return v;
}

/**
 * With "ask before opening a new site" on, raw CDP stays inside the session's own tab: commands
 * that reach other targets or browser-wide state (every site's cookies, cache, storage) would
 * bypass the per-site permissions. Full access has none to bypass, so nothing is refused there.
 */
const CDP_DENIED_PREFIXES = ["Target.", "Browser.", "Storage.", "SystemInfo."];
const CDP_DENIED_METHODS = new Set([
	"Network.getAllCookies",
	"Network.clearBrowserCookies",
	"Network.clearBrowserCache",
	"Page.close",
	"Page.navigateToHistoryEntry",
	"Page.setDownloadBehavior",
]);

async function checkCdpMethod(method: string): Promise<void> {
	if (!/^[A-Z][A-Za-z]+\.[a-z][A-Za-z]+$/.test(method)) {
		throw new BridgeError(ERR.BAD_PARAMS, `method must look like Domain.command, got "${method}"`);
	}
	const denied = CDP_DENIED_METHODS.has(method) || CDP_DENIED_PREFIXES.some((p) => method.startsWith(p));
	if (denied && (await getPermissionMode()) === "ask") {
		throw new BridgeError(
			ERR.PERMISSION_DENIED,
			`${method} is not available through the bridge: it reaches beyond this session's tab. Use navigate, tabs_create or tabs_close for tab changes.`,
		);
	}
}

async function resolveTab(ctx: HandlerContext, params: Params, attach: boolean): Promise<number> {
	const tabId = num(params, "tabId");
	if (tabId !== undefined) {
		if (!ctx.session.tabIds.includes(tabId)) {
			throw new BridgeError(ERR.NOT_FOUND, `Tab ${tabId} is not owned by this session. Call tabs.context.`);
		}
		await ctx.session.setCurrent(tabId);
	}
	const tab = attach ? await ctx.session.attachedCurrentTab() : await ctx.session.requireCurrentTab();
	if (tab.id === undefined) throw new BridgeError(ERR.NO_TAB, "No tab available");
	return tab.id;
}

/** `stillLoading`: the wait gave up before DOMContentLoaded (the page may be incomplete). */
async function tabSummary(tabId: number, stillLoading = false) {
	const tab = await chrome.tabs.get(tabId);
	return {
		tabId,
		url: tab.url ?? tab.pendingUrl ?? "",
		title: tab.title ?? "",
		...(stillLoading ? { loading: true } : {}),
	};
}

function target(params: Params): ElementTarget {
	return { ref: str(params, "ref"), selector: str(params, "selector"), text: str(params, "text") };
}

function hasTarget(t: ElementTarget): boolean {
	return !!(t.ref || t.selector || t.text);
}

/** The page after a step, for callers that asked for it instead of a separate read_page. */
function readPage(tabId: number, read: unknown): Promise<Snapshot> {
	const interactive = read === "interactive";
	return snapshot(tabId, { filter: interactive ? "interactive" : "all", maxTextChars: interactive ? 0 : 3000 });
}

async function pointFor(_ctx: HandlerContext, params: Params, tabId: number): Promise<{ x: number; y: number }> {
	const x = num(params, "x");
	const y = num(params, "y");
	if (x !== undefined && y !== undefined) return screenshotToCss(tabId, { x, y });
	const t = target(params);
	if (!hasTarget(t)) throw new BridgeError(ERR.BAD_PARAMS, "Provide ref, selector, text, or x and y");
	const rect = await locate(tabId, t);
	return { x: rect.x, y: rect.y };
}

/** One `actions` step as [handler, params]; accepts the spellings models reach for. */
function normalizeStep(step: Params, i: number): [string, Params] {
	const obj = (v: unknown): Params => (v && typeof v === "object" ? (v as Params) : {});
	if ("navigate" in step)
		return ["navigate", typeof step.navigate === "string" ? { url: step.navigate } : obj(step.navigate)];
	if ("fill" in step) return ["fill", obj(step.fill)];
	if ("press" in step) return ["press", typeof step.press === "string" ? { key: step.press } : obj(step.press)];
	if ("key" in step) return ["press", { key: String(step.key), ...(step.repeat ? { repeat: step.repeat } : {}) }];
	if ("type" in step) return ["type", typeof step.type === "string" ? { text: step.type } : obj(step.type)];
	if ("text" in step) return ["type", { text: String(step.text) }];
	if ("click" in step) return ["click", obj(step.click)];
	if ("doubleClick" in step || "dblclick" in step)
		return ["click", { ...obj(step.doubleClick ?? step.dblclick), clickCount: 2 }];
	if ("drag" in step) return ["drag", obj(step.drag)];
	if ("hover" in step || "move" in step) return ["hover", obj(step.hover ?? step.move)];
	if ("scroll" in step) return ["scroll", obj(step.scroll)];
	for (const k of ["wait", "sleep", "pause"])
		if (k in step) return ["wait", typeof step[k] === "number" ? { ms: step[k] } : obj(step[k])];
	if ("screenshot" in step) return ["screenshot", {}];
	throw new BridgeError(
		ERR.BAD_PARAMS,
		`step ${i}: expected one of navigate, fill, press, click, doubleClick, drag, type, hover, scroll, wait, screenshot`,
	);
}

/** The largest viewport or GIF side an agent may ask for. */
const MAX_VIEWPORT_SIDE = 10000;

// Native messaging caps host->extension frames at 1 MiB, so files arrive in chunks and wait here.
const MAX_UPLOAD_CHARS = 36 * 1024 * 1024;
const uploads = new Map<string, { chunks: string[]; chars: number }>();

/** The last screenshots each client took, so upload_image can send one without a round trip. */
const SHOTS_KEPT = 4;
const shots = new Map<string, Map<string, { data: string; mimeType: string }>>();

function rememberShot(clientId: string, shot: { data: string; mimeType: string }): string {
	let kept = shots.get(clientId);
	if (!kept) {
		kept = new Map();
		shots.set(clientId, kept);
	}
	const imageId = crypto.randomUUID().slice(0, 8);
	kept.set(imageId, { data: shot.data, mimeType: shot.mimeType });
	if (kept.size > SHOTS_KEPT) kept.delete(kept.keys().next().value as string);
	return imageId;
}

function forgetUploads(clientId: string): void {
	for (const key of uploads.keys()) if (key.startsWith(`${clientId}:`)) uploads.delete(key);
}

/** Drop what a client left behind when it disconnects. */
export function forgetClient(clientId: string): void {
	shots.delete(clientId);
	forgetUploads(clientId);
}

function describeTarget(params: Params): string {
	return str(params, "text") ?? str(params, "ref") ?? str(params, "selector") ?? "";
}

function record(ctx: HandlerContext, action: GifAction): void {
	noteGifAction(ctx.session, action);
}

/** Where files go: a named element or the page's file input, or a point of the latest screenshot. */
async function deliverTo(params: Params, tabId: number, files: PageFile[]) {
	const x = num(params, "x");
	const y = num(params, "y");
	const point = x !== undefined && y !== undefined ? screenshotToCss(tabId, { x, y }) : undefined;
	return deliverFiles(tabId, target(params), files, point);
}

/** Skills made for this page, so a harness knows the site has ready-made helpers. */
async function skillsFor(url: string): Promise<Array<{ name: string; description: string }>> {
	const skills = await readStore<Skill>("skills").catch(() => [] as Skill[]);
	return skills
		.filter((s) => !s.domainPatterns.includes(ANY_SITE) && matchesAnyPattern(url, s.domainPatterns))
		.map((s) => ({ name: s.name, description: s.shortDescription }));
}

export const handlers: Record<string, Handler> = {
	"tabs.context": async (ctx) => {
		const tabs = await ctx.session.tabs();
		return {
			tabs: tabs.map((t) => ({
				tabId: t.id,
				url: t.url,
				title: t.title,
				current: t.current,
				...(t.inGroup ? {} : { inGroup: false }),
			})),
		};
	},

	"tabs.create": async (ctx, params) => {
		const url = str(params, "url");
		if (url) await ctx.checkUrl(url);
		const tab = await ctx.session.createTab(url);
		const ready = url ? await waitForLoad(tab.id!, 20000) : true;
		return tabSummary(tab.id!, !ready);
	},

	"tabs.close": async (ctx, params) => {
		const tabId = num(params, "tabId");
		if (tabId === undefined) throw new BridgeError(ERR.BAD_PARAMS, "tabId is required");
		await ctx.session.closeTab(tabId);
		return { closed: tabId };
	},

	"tabs.select": async (ctx, params) => {
		const tabId = num(params, "tabId");
		if (tabId === undefined) throw new BridgeError(ERR.BAD_PARAMS, "tabId is required");
		const tab = await ctx.session.setCurrent(tabId);
		return tabSummary(tab.id!);
	},

	"tabs.show": async (ctx, params) => {
		const tabId = num(params, "tabId") ?? ctx.session.currentTabId;
		if (tabId === undefined) throw new BridgeError(ERR.NO_TAB, "No tab to show");
		await ctx.session.show(tabId);
		return tabSummary(tabId);
	},

	navigate: async (ctx, params) => {
		const url = requireStr(params, "url");
		const history = url === "back" || url === "forward";
		if (!history) await ctx.checkUrl(url);
		// The first navigate of a session opens its tab straight on the URL (no blank tab).
		const withRead = async (tabId: number, timedOut: boolean) => {
			const summary = await tabSummary(tabId, timedOut);
			const skills = await skillsFor(summary.url);
			return {
				...summary,
				...(skills.length > 0 ? { skills } : {}),
				...(params.read ? { page: await readPage(tabId, params.read) } : {}),
			};
		};
		if (!history && num(params, "tabId") === undefined && !(await ctx.session.currentTab())) {
			const tab = await ctx.session.createTab(url);
			const ready = await waitForLoad(tab.id!, num(params, "timeoutMs") ?? 20000);
			return withRead(tab.id!, !ready);
		}
		record(ctx, { kind: "label", label: url === "back" || url === "forward" ? `Go ${url}` : `Open ${url}` });
		const tabId = await resolveTab(ctx, params, false);
		let timedOut = false;
		if (url === "back") timedOut = !(await goBack(tabId));
		else if (url === "forward") timedOut = !(await goForward(tabId));
		else {
			const waitUntil = str(params, "waitUntil") === "load" ? "load" : "domcontentloaded";
			timedOut = (await navigateTabDetailed(tabId, url, { waitUntil, timeoutMs: num(params, "timeoutMs") ?? 20000 }))
				.timedOut;
		}
		return withRead(tabId, timedOut);
	},

	screenshot: async (ctx, params) => {
		const tabId = await resolveTab(ctx, params, true);
		const clip = params.clip as { x: number; y: number; width: number; height: number } | undefined;
		const shot = await captureScreenshot(tabId, {
			maxWidth: num(params, "maxWidth"),
			fullPage: params.fullPage === true,
			clip,
			format: str(params, "format") === "png" ? "png" : "jpeg",
			quality: num(params, "quality"),
		});
		return { ...shot, imageId: rememberShot(ctx.clientId, shot) };
	},

	"upload.chunk": async (ctx, params) => {
		const key = `${ctx.clientId}:${requireStr(params, "uploadId")}`;
		const data = requireStr(params, "data");
		const upload = uploads.get(key) ?? { chunks: [], chars: 0 };
		// A reconnect mid-upload lands on a new client or a fresh worker: the start is gone, and
		// delivering the rest would hand the page a truncated file with no error.
		if (num(params, "offset") !== upload.chars) {
			uploads.delete(key);
			throw new BridgeError(ERR.BAD_PARAMS, "The upload was interrupted. Call file_upload again.");
		}
		upload.chars += data.length;
		// Per client, not per upload: abandoned uploads add up until the client disconnects.
		let held = data.length;
		for (const [other, entry] of uploads) if (other.startsWith(`${ctx.clientId}:`)) held += entry.chars;
		if (upload.chars > MAX_UPLOAD_CHARS || held > MAX_UPLOAD_CHARS) {
			forgetUploads(ctx.clientId);
			throw new BridgeError(ERR.BAD_PARAMS, "The upload is too large (25 MB at most)");
		}
		upload.chunks.push(data);
		uploads.set(key, upload);
		return { received: upload.chars };
	},

	/** Hand chunked files to the page. */
	"upload.commit": async (ctx, params) => {
		const specs = params.files as Array<{ uploadId: string; name: string; mimeType: string }> | undefined;
		if (!Array.isArray(specs) || specs.length === 0) throw new BridgeError(ERR.BAD_PARAMS, "files is required");
		const files = specs.map((spec) => {
			const key = `${ctx.clientId}:${spec.uploadId}`;
			const upload = uploads.get(key);
			if (!upload) throw new BridgeError(ERR.NOT_FOUND, `No upload ${spec.uploadId}`);
			uploads.delete(key);
			return { name: spec.name, mimeType: spec.mimeType, data: upload.chunks.join("") };
		});
		const tabId = await resolveTab(ctx, params, true);
		return deliverTo(params, tabId, files);
	},

	/** Send a screenshot taken earlier to a file input or drop target, e.g. into a bug report. */
	"upload.image": async (ctx, params) => {
		const imageId = requireStr(params, "imageId");
		const shot = shots.get(ctx.clientId)?.get(imageId);
		if (!shot) throw new BridgeError(ERR.NOT_FOUND, `No screenshot ${imageId}; take a new one`);
		const extension = shot.mimeType === "image/png" ? "png" : "jpg";
		const name = str(params, "filename") ?? `screenshot.${extension}`;
		const tabId = await resolveTab(ctx, params, true);
		return deliverTo(params, tabId, [{ name, mimeType: shot.mimeType, data: shot.data }]);
	},

	/** Record the session's tab as a GIF; export hands the file back to the caller. */
	gif: async (ctx, params) => {
		const recorder = gifRecorderFor(ctx.session);
		switch (requireStr(params, "action")) {
			case "start_recording":
				await recorder.start(await resolveTab(ctx, params, true), ctx.clientId);
				return { recording: true };
			case "stop_recording":
				await recorder.stop();
				return { recording: false, frames: recorder.frameCount };
			case "export": {
				const options = (params.options ?? {}) as GifOptions;
				const width = options.maxWidth;
				if (width !== undefined && (!Number.isInteger(width) || width < 1 || width > MAX_VIEWPORT_SIDE)) {
					throw new BridgeError(ERR.BAD_PARAMS, `maxWidth must be a whole number from 1 to ${MAX_VIEWPORT_SIDE}`);
				}
				return recorder.export(options);
			}
			case "clear":
				recorder.clear();
				return { frames: 0 };
			default:
				throw new BridgeError(ERR.BAD_PARAMS, "action must be start_recording, stop_recording, export or clear");
		}
	},

	"screencast.start": async (ctx, params) => {
		const tabId = await resolveTab(ctx, params, true);
		await startScreencast(
			tabId,
			ctx.clientId,
			{
				format: str(params, "format") === "png" ? "png" : "jpeg",
				quality: num(params, "quality"),
				maxWidth: num(params, "maxWidth"),
				maxHeight: num(params, "maxHeight"),
				maxFps: num(params, "maxFps"),
				initScript: str(params, "initScript"),
			},
			(frame) => ctx.emit("screencast_frame", { tabId, data: frame.data, metadata: frame.metadata }),
			(reason) => ctx.emit("screencast_stopped", { tabId, reason }),
		);
		return { tabId, streaming: true };
	},

	"screencast.stop": async (ctx, params) => {
		const tabId = await resolveTab(ctx, params, false);
		return { tabId, stopped: await stopScreencast(tabId) };
	},

	snapshot: async (ctx, params) => {
		const tabId = await resolveTab(ctx, params, true);
		const filter = str(params, "filter") === "interactive" ? "interactive" : "all";
		return snapshot(tabId, {
			filter,
			maxNodes: num(params, "maxNodes"),
			maxTextChars: num(params, "maxTextChars"),
		});
	},

	text: async (ctx, params) => {
		const tabId = await resolveTab(ctx, params, false);
		const text = await pageText(tabId, str(params, "selector"), num(params, "maxChars"));
		return { ...(await tabSummary(tabId)), text };
	},

	html: async (ctx, params) => {
		const tabId = await resolveTab(ctx, params, false);
		const html = await pageHtml(tabId, str(params, "selector"), num(params, "maxChars"));
		return { ...(await tabSummary(tabId)), html };
	},

	find: async (ctx, params) => {
		const query = requireStr(params, "query");
		const limit = num(params, "limit") ?? 20;
		if (!Number.isInteger(limit) || limit < 1)
			throw new BridgeError(ERR.BAD_PARAMS, "limit must be a positive integer");
		const tabId = await resolveTab(ctx, params, false);
		const snap = await snapshot(tabId, { filter: "all", maxNodes: 600, maxTextChars: 0 });
		return { matches: rankNodes(snap.nodes, query, limit) };
	},

	/** Render the tab at another size, to test a layout. */
	"window.resize": async (ctx, params) => {
		const tabId = await resolveTab(ctx, params, true);
		const presets: Record<string, ViewportSize | undefined> = {
			mobile: { width: 375, height: 812, mobile: true },
			tablet: { width: 768, height: 1024 },
			desktop: undefined,
		};
		const preset = str(params, "preset");
		const width = num(params, "width");
		const height = num(params, "height");
		if (preset !== undefined && !(preset in presets)) {
			throw new BridgeError(ERR.BAD_PARAMS, "preset must be mobile, tablet or desktop");
		}
		if (preset === undefined && (width === undefined || height === undefined)) {
			throw new BridgeError(ERR.BAD_PARAMS, "Provide preset, or width and height");
		}
		for (const side of preset === undefined ? [width, height] : []) {
			if (!Number.isInteger(side) || (side as number) < 1 || (side as number) > MAX_VIEWPORT_SIDE) {
				throw new BridgeError(
					ERR.BAD_PARAMS,
					`width and height must be whole numbers from 1 to ${MAX_VIEWPORT_SIDE}`,
				);
			}
		}
		const size = preset !== undefined ? presets[preset] : { width: width as number, height: height as number };
		await setAgentViewport(tabId, size);
		return { tabId, ...(size ?? AGENT_VIEWPORT) };
	},

	click: async (ctx, params) => {
		const tabId = await resolveTab(ctx, params, true);
		const p = await pointFor(ctx, params, tabId);
		const button = str(params, "button");
		record(ctx, { kind: "click", x: p.x, y: p.y, label: `Click ${describeTarget(params)}`.trim() });
		await click(tabId, p.x, p.y, {
			button: button === "right" || button === "middle" ? button : "left",
			clickCount: num(params, "clickCount") ?? 1,
		});
		return { clicked: p };
	},

	hover: async (ctx, params) => {
		const tabId = await resolveTab(ctx, params, true);
		const p = await pointFor(ctx, params, tabId);
		await hover(tabId, p.x, p.y);
		return { hovered: p };
	},

	drag: async (ctx, params) => {
		const tabId = await resolveTab(ctx, params, true);
		const from = params.from as { x: number; y: number } | undefined;
		const to = params.to as { x: number; y: number } | undefined;
		if (!from || !to) throw new BridgeError(ERR.BAD_PARAMS, "from and to are required");
		const start = screenshotToCss(tabId, from);
		const end = screenshotToCss(tabId, to);
		record(ctx, { kind: "drag", x: start.x, y: start.y, toX: end.x, toY: end.y, label: "Drag" });
		await drag(tabId, start, end);
		return { dragged: { from, to } };
	},

	type: async (ctx, params) => {
		const text = requireStr(params, "text");
		const tabId = await resolveTab(ctx, params, true);
		const t = { ref: str(params, "ref"), selector: str(params, "selector"), text: str(params, "target") };
		if (hasTarget(t)) {
			const rect = await locate(tabId, t);
			await click(tabId, rect.x, rect.y);
		}
		record(ctx, { kind: "label", label: `Type "${text.slice(0, 40)}"` });
		await typeText(tabId, text, { keys: params.keys === true });
		if (params.submit === true) await pressKey(tabId, "Enter");
		return { typed: text.length };
	},

	press: async (ctx, params) => {
		const key = requireStr(params, "key");
		const tabId = await resolveTab(ctx, params, true);
		const repeat = num(params, "repeat") ?? 1;
		record(ctx, { kind: "label", label: `Press ${key}` });
		for (let i = 0; i < repeat; i++) await pressKey(tabId, key);
		return { pressed: key, repeat };
	},

	scroll: async (ctx, params) => {
		const tabId = await resolveTab(ctx, params, true);
		const x = num(params, "x");
		const y = num(params, "y");
		const dx = num(params, "dx") ?? 0;
		const dy = num(params, "dy") ?? 0;
		if (x !== undefined && y !== undefined && !params.ref && !params.selector && !params.to) {
			// Wheel at a point: scrolls the innermost scrollable under the cursor.
			const at = screenshotToCss(tabId, { x, y });
			await cdpScroll(tabId, at.x, at.y, dx, dy);
			return runInPage(tabId, "({ scrollX: Math.round(window.scrollX), scrollY: Math.round(window.scrollY) })");
		}
		const to = str(params, "to");
		return scrollPage(tabId, {
			dx,
			dy,
			ref: str(params, "ref"),
			selector: str(params, "selector"),
			to: to === "top" || to === "bottom" ? to : undefined,
		});
	},

	fill: async (ctx, params) => {
		const value = str(params, "value") ?? "";
		const tabId = await resolveTab(ctx, params, false);
		const t = target(params);
		if (!hasTarget(t)) throw new BridgeError(ERR.BAD_PARAMS, "ref, selector or text is required");
		record(ctx, { kind: "label", label: `Fill ${describeTarget(params)}`.trim() });
		await fillElement(tabId, t, value);
		return { filled: t };
	},

	"skills.list": async (_ctx, params) => {
		const url = str(params, "url");
		const skills = await readStore<Skill>("skills");
		return {
			skills: skills
				.filter((s) => !url || matchesAnyPattern(url, s.domainPatterns))
				.map((s) => ({ name: s.name, sites: s.domainPatterns, description: s.shortDescription })),
		};
	},

	"skills.get": async (_ctx, params) => {
		const name = requireStr(params, "name");
		const skill = (await readStore<Skill>("skills")).find((s) => s.name === name);
		if (!skill) throw new BridgeError(ERR.NOT_FOUND, `No skill named ${name}`);
		const { library = "", ...rest } = skill;
		return params.includeLibrary === true ? skill : { ...rest, hasLibrary: library.trim().length > 0 };
	},

	"prompts.list": async () => ({ prompts: await readStore<SavedPrompt>("prompts") }),

	evaluate: async (ctx, params) => {
		let code = requireStr(params, "code");
		const skillName = str(params, "skill");
		if (skillName) {
			const skill = (await readStore<Skill>("skills")).find((s) => s.name === skillName);
			if (!skill) throw new BridgeError(ERR.NOT_FOUND, `No skill named ${skillName}`);
			code = `(async () => { ${skill.library ?? ""}\n; return (${code}); })()`;
		}
		const world = str(params, "world") === "main" ? "main" : "user";
		if (world === "main") {
			const tabId = await resolveTab(ctx, params, true);
			return { value: await evaluateMain(tabId, code) };
		}
		const tabId = await resolveTab(ctx, params, true);
		return { value: await injectScript(tabId, code) };
	},

	/** Any Chrome DevTools Protocol command on the session's current tab. */
	cdp: async (ctx, params) => {
		const method = requireStr(params, "method");
		await checkCdpMethod(method);
		const cdpParams = params.params ?? {};
		if (typeof cdpParams !== "object" || Array.isArray(cdpParams)) {
			throw new BridgeError(ERR.BAD_PARAMS, "params must be an object");
		}
		if (method === "Page.navigate") {
			const url = str(cdpParams as Params, "url");
			if (!url) throw new BridgeError(ERR.BAD_PARAMS, "Page.navigate needs params.url");
			await ctx.checkUrl(url);
		}
		const tabId = await resolveTab(ctx, params, true);
		return { tabId, result: await cdpSend(tabId, method, cdpParams as Params) };
	},

	/** Sign in from 1Password. The result says which fields were filled, never with what. */
	"login.fill": async (ctx, params) => fillLogin(await resolveTab(ctx, params, false), str(params, "item")),

	/** Tell the user something needs them; clicking the notification shows the tab. */
	notify: async (ctx, params) => {
		const tabId = num(params, "tabId") ?? ctx.session.currentTabId;
		if (tabId !== undefined && !ctx.session.tabIds.includes(tabId)) {
			throw new BridgeError(ERR.NOT_FOUND, `Tab ${tabId} is not owned by this session`);
		}
		const shown = await showNotification({
			kind: "needs-you",
			title: requireStr(params, "title"),
			message: str(params, "message") ?? "",
			tabId,
		});
		return { shown };
	},

	wait: async (ctx, params) => {
		const ms = num(params, "ms");
		if (ms !== undefined && !params.selector && !params.text && !params.urlIncludes) {
			await new Promise((r) => setTimeout(r, Math.min(ms, 30000)));
			return { waited: ms };
		}
		const tabId = await resolveTab(ctx, params, false);
		const ok = await waitFor(
			tabId,
			{ selector: str(params, "selector"), text: str(params, "text"), urlIncludes: str(params, "urlIncludes") },
			num(params, "timeoutMs") ?? 10000,
		);
		if (!ok) throw new BridgeError(ERR.TIMEOUT, "Condition not met before timeout");
		return { ...(await tabSummary(tabId)), matched: true };
	},

	/**
	 * Several steps in one call (navigate / fill / press / click / drag / type / hover / scroll /
	 * wait), optionally ending with a screenshot or a page read. Each model turn costs seconds
	 * where a step costs milliseconds: a form is two calls this way instead of one per field.
	 * Stops at the first failing step and says which.
	 */
	actions: async (ctx, params) => {
		const steps = params.steps;
		if (!Array.isArray(steps) || steps.length === 0)
			throw new BridgeError(ERR.BAD_PARAMS, "steps must be a non-empty array");
		if (steps.length > 40) throw new BridgeError(ERR.BAD_PARAMS, "at most 40 steps per call");
		// Apps react to input a frame later (a text editor opens after Enter, a tool arms after
		// its shortcut); without a short settle the next keystroke lands before it and is lost.
		const settleMs = Math.max(0, Math.min(1000, num(params, "settleMs") ?? 80));
		let wantShot = params.screenshot === true;
		// A step can name its own tab; what comes back after the last step shows where it ended.
		let lastTab: unknown = params.tabId;
		const done: unknown[] = [];
		for (let i = 0; i < steps.length; i++) {
			const [kind, sub] = normalizeStep(steps[i] as Params, i);
			if (kind === "screenshot") {
				wantShot = true;
				continue;
			}
			const withTab = params.tabId !== undefined && sub.tabId === undefined ? { ...sub, tabId: params.tabId } : sub;
			if (withTab.tabId !== undefined) lastTab = withTab.tabId;
			try {
				done.push(await handlers[kind](ctx, withTab));
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				throw new BridgeError(ERR.BAD_PARAMS, `step ${i} (${kind}) failed after ${i} steps succeeded: ${message}`);
			}
			if (settleMs > 0 && i < steps.length - 1) await new Promise((r) => setTimeout(r, settleMs));
		}
		const out: Record<string, unknown> = { steps: done.length };
		if (wantShot) out.screenshot = await handlers.screenshot(ctx, { tabId: lastTab });
		if (params.read) out.page = await readPage(await resolveTab(ctx, { tabId: lastTab }, true), params.read);
		return out;
	},

	"console.read": async (ctx, params) => {
		const tabId = await resolveTab(ctx, params, true);
		await enableConsoleCapture(tabId);
		return {
			entries: consoleEntries(tabId, {
				onlyErrors: params.onlyErrors === true,
				pattern: str(params, "pattern"),
				clear: params.clear === true,
				limit: num(params, "limit"),
			}),
		};
	},

	"network.read": async (ctx, params) => {
		const tabId = await resolveTab(ctx, params, true);
		await enableNetworkCapture(tabId);
		return {
			entries: networkEntries(tabId, {
				urlPattern: str(params, "urlPattern"),
				clear: params.clear === true,
				limit: num(params, "limit"),
			}),
		};
	},
};
