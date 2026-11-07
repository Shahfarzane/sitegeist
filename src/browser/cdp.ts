/**
 * chrome.debugger helpers: one attachment per tab, kept for as long as the tab is
 * owned, with focus emulation so hidden tabs keep running requestAnimationFrame and
 * IntersectionObserver. Screenshots come from the compositor surface, which works
 * on tabs that are not visible; nothing here activates a tab.
 */

const PROTOCOL_VERSION = "1.3";

/** Tabs where the user cancelled the debugger (closed the infobar). Cleared on navigation. */
const bannedTabs = new Set<number>();
const attachedTabs = new Set<number>();
let listenersInstalled = false;

export function isRestrictedUrl(url: string): boolean {
	return (
		url.startsWith("chrome://") ||
		url.startsWith("chrome-extension://") ||
		url.startsWith("brave://") ||
		url.startsWith("edge://") ||
		url.startsWith("arc://") ||
		url.startsWith("vivaldi://") ||
		url.startsWith("opera://") ||
		url.startsWith("about:") ||
		url.startsWith("devtools://") ||
		url.startsWith("https://chrome.google.com/webstore") ||
		url.startsWith("https://chromewebstore.google.com")
	);
}

/**
 * Tabs on screen: the active tab of each window, and since Chrome 155 the other half of a
 * split view with it, which is visible without being `active`.
 */
export function shownTabIds(tabs: Array<Pick<chrome.tabs.Tab, "id" | "active" | "splitViewId">>): Set<number> {
	const activeSplits = new Set<number>();
	for (const t of tabs)
		if (t.active && t.splitViewId !== undefined && t.splitViewId !== -1) activeSplits.add(t.splitViewId);
	const shown = new Set<number>();
	for (const t of tabs) {
		if (t.id === undefined) continue;
		if (t.active || (t.splitViewId !== undefined && activeSplits.has(t.splitViewId))) shown.add(t.id);
	}
	return shown;
}

export async function isTabShown(tab: chrome.tabs.Tab): Promise<boolean> {
	if (tab.active) return true;
	if (tab.splitViewId === undefined || tab.splitViewId === -1 || tab.id === undefined) return false;
	const inWindow = await chrome.tabs.query({ windowId: tab.windowId }).catch(() => [] as chrome.tabs.Tab[]);
	return shownTabIds(inWindow).has(tab.id);
}

/** The user can see these tabs now: give them their real size. */
async function releaseShown(windowId: number): Promise<void> {
	const inWindow = await chrome.tabs.query({ windowId }).catch(() => [] as chrome.tabs.Tab[]);
	for (const id of shownTabIds(inWindow)) await releaseAgentViewport(id);
}

// ---- Page dialogs ---------------------------------------------------------------
//
// A JavaScript dialog (alert, confirm, prompt, beforeunload) stops the page until it is
// answered, so every later Runtime.evaluate on the tab hangs. Dialogs in tabs the debugger
// holds are answered at once: accepted, or as preset with setNextDialogAnswer, and logged
// so the agent learns what the page asked.

export interface DialogRecord {
	type: string;
	message: string;
	accepted: boolean;
	promptText?: string;
	url: string;
}

const nextDialogAnswer = new Map<number, { accept: boolean; promptText?: string }>();
const dialogLog = new Map<number, DialogRecord[]>();
let dialogObserver: ((tabId: number, dialog: DialogRecord) => void) | undefined;

/** How to answer the next confirm or prompt on this tab (alerts and beforeunload are always accepted). */
export function setNextDialogAnswer(tabId: number, answer: { accept: boolean; promptText?: string }): void {
	nextDialogAnswer.set(tabId, answer);
}

/** Dialogs answered on these tabs since the last call; clears them. */
export function takeDialogs(tabIds: number[]): DialogRecord[] {
	const out: DialogRecord[] = [];
	for (const id of tabIds) {
		const log = dialogLog.get(id);
		if (log?.length) out.push(...log.splice(0));
	}
	return out;
}

export function onDialog(observer: (tabId: number, dialog: DialogRecord) => void): void {
	dialogObserver = observer;
}

function answerDialog(
	tabId: number,
	p: { type?: string; message?: string; defaultPrompt?: string; url?: string },
): void {
	const type = String(p.type ?? "alert");
	const preset = nextDialogAnswer.get(tabId);
	nextDialogAnswer.delete(tabId);
	const asks = type === "confirm" || type === "prompt";
	const accept = asks ? (preset?.accept ?? true) : true;
	const promptText = type === "prompt" && accept ? (preset?.promptText ?? p.defaultPrompt ?? "") : undefined;
	send(tabId, "Page.handleJavaScriptDialog", { accept, ...(promptText !== undefined ? { promptText } : {}) }).catch(
		() => undefined,
	);
	const record: DialogRecord = {
		type,
		message: String(p.message ?? ""),
		accepted: accept,
		promptText,
		url: String(p.url ?? ""),
	};
	const log = dialogLog.get(tabId) ?? [];
	log.push(record);
	if (log.length > 20) log.splice(0, log.length - 20);
	dialogLog.set(tabId, log);
	consoleBuffers.get(tabId)?.push({
		level: "dialog",
		text: `${type}(${JSON.stringify(record.message)}) ${accept ? "accepted" : "dismissed"}`,
		timestamp: Date.now(),
	});
	dialogObserver?.(tabId, record);
}

function installListeners(): void {
	if (listenersInstalled) return;
	listenersInstalled = true;
	chrome.debugger.onEvent.addListener((source, method, params) => {
		if (method === "Page.javascriptDialogOpening" && source.tabId !== undefined)
			answerDialog(source.tabId, (params ?? {}) as Record<string, string>);
	});
	chrome.tabs.onActivated.addListener(({ windowId }) => void releaseShown(windowId));
	chrome.tabs.onUpdated.addListener((_tabId, change, tab) => {
		if (change.splitViewId !== undefined) void releaseShown(tab.windowId);
	});
	chrome.debugger.onDetach.addListener((source, reason) => {
		if (source.tabId === undefined) return;
		attachedTabs.delete(source.tabId);
		viewportTabs.delete(source.tabId);
		if (reason === "canceled_by_user") bannedTabs.add(source.tabId);
	});
	chrome.webNavigation.onCommitted.addListener((details) => {
		if (details.frameId === 0) bannedTabs.delete(details.tabId);
	});
	chrome.tabs.onRemoved.addListener((tabId) => {
		attachedTabs.delete(tabId);
		viewportTabs.delete(tabId);
		requestedViewports.delete(tabId);
		bannedTabs.delete(tabId);
		nextDialogAnswer.delete(tabId);
		dialogLog.delete(tabId);
	});
}

async function send<T = unknown>(tabId: number, method: string, params?: Record<string, unknown>): Promise<T> {
	return (await chrome.debugger.sendCommand({ tabId }, method, params)) as T;
}

/**
 * Chrome 155 to 157 refuse chrome.debugger.attach when enterprise policy blocks the site for
 * extensions (runtime_blocked_hosts) or blocks screenshots (DisableScreenshots, DLP rules).
 */
export function attachError(tabId: number, message: string): string {
	if (/Host access is restricted by policy/i.test(message))
		return `Cannot attach to tab ${tabId}: a browser policy (ExtensionSettings runtime_blocked_hosts) blocks extensions on this site.`;
	if (/Screenshot capture is restricted by policy/i.test(message))
		return `Cannot attach to tab ${tabId}: a browser policy (DisableScreenshots or a data-protection screenshot rule) blocks the debugger on this page.`;
	return `Cannot attach to tab ${tabId}: ${message}`;
}

/** Attach if needed. Idempotent; tolerates attachments made before a service worker restart. */
export async function ensureAttached(tabId: number): Promise<void> {
	installListeners();
	if (bannedTabs.has(tabId)) {
		throw new Error("The debugger was closed by the user on this tab. Navigate the tab to a new page to continue.");
	}
	if (!attachedTabs.has(tabId)) {
		// Always try: getTargets' `attached` is true for any client, so DevTools open on the tab
		// read as "we are attached" and every command then failed. Our own earlier attachment,
		// from before a service worker restart, is the "already attached" error.
		try {
			await chrome.debugger.attach({ tabId }, PROTOCOL_VERSION);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			if (!message.includes("already attached")) throw new Error(attachError(tabId, message));
		}
		attachedTabs.add(tabId);
		// Hidden tabs freeze rAF; focus emulation unfreezes it and makes the page report
		// itself visible, so lazy loading and infinite scroll keep working off-screen.
		await send(tabId, "Emulation.setFocusEmulationEnabled", { enabled: true }).catch(() => undefined);
		// Page events carry javascriptDialogOpening: an unanswered alert() blocks every script on the tab.
		await send(tabId, "Page.enable").catch(() => undefined);
	}
	await ensureAgentViewport(tabId);
}

// ---- Agent viewport ------------------------------------------------------------
//
// Background agent tabs render at a fixed 1280x800 CSS viewport, whatever the size of
// the window they live in. Screenshots are then 1:1 with page coordinates, so what a
// model reads off a screenshot, from getBoundingClientRect(), or from a click result
// are the same numbers, and layouts do not change between machines and windows. The
// override is dropped as soon as the user looks at the tab (it would letterbox the page)
// and comes back the next time an agent acts on it while it is hidden.

export const AGENT_VIEWPORT = { width: 1280, height: 800 };
const viewportTabs = new Set<number>();

export interface ViewportSize {
	width: number;
	height: number;
	/** Emulate a phone: mobile layout rules and touch. */
	mobile?: boolean;
}

/** Sizes an agent asked for with resize_window, per tab. */
const requestedViewports = new Map<number, ViewportSize>();

async function applyViewport(tabId: number): Promise<void> {
	const size = requestedViewports.get(tabId) ?? AGENT_VIEWPORT;
	const mobile = "mobile" in size && size.mobile === true;
	await send(tabId, "Emulation.setDeviceMetricsOverride", {
		width: size.width,
		height: size.height,
		deviceScaleFactor: mobile ? 2 : 0,
		mobile,
		// No scrollbar gutter (Chrome 147+): the whole 1280 px is page, so screenshot and page coordinates match.
		scrollbarType: "overlay",
	});
	await send(tabId, "Emulation.setTouchEmulationEnabled", { enabled: mobile }).catch(() => undefined);
}

async function ensureAgentViewport(tabId: number): Promise<void> {
	if (viewportTabs.has(tabId)) return;
	const tab = await chrome.tabs.get(tabId).catch(() => undefined);
	if (!tab || (await isTabShown(tab))) return;
	try {
		await applyViewport(tabId);
		viewportTabs.add(tabId);
	} catch {
		/* not attachable right now; the next call retries */
	}
}

/** Render a tab at this size to test a layout; undefined goes back to the default. */
export async function setAgentViewport(tabId: number, size: ViewportSize | undefined): Promise<void> {
	await ensureAttached(tabId);
	if (size) requestedViewports.set(tabId, size);
	else requestedViewports.delete(tabId);
	// The default is for tabs nobody sees; on a tab in front it would letterbox the page.
	const tab = await chrome.tabs.get(tabId);
	if (!size && (await isTabShown(tab))) {
		await releaseAgentViewport(tabId);
		return;
	}
	await applyViewport(tabId);
	viewportTabs.add(tabId);
}

/** Give the tab its real size back (the user is about to see it, or the agent let go). */
export async function releaseAgentViewport(tabId: number): Promise<void> {
	if (!viewportTabs.delete(tabId)) return;
	await send(tabId, "Emulation.clearDeviceMetricsOverride").catch(() => undefined);
}

/** Detach the debugger. A tab that is being screencast keeps it unless `force`:
 *  another client of the same session hanging up must not end a live view. */
export async function detachTab(tabId: number, force = false): Promise<void> {
	if (!force && screencasts.has(tabId)) return;
	if (force) await stopScreencast(tabId).catch(() => undefined);
	// Chrome before 154 kept an emulated size after detach and left the tab at 1280x800.
	await releaseAgentViewport(tabId);
	attachedTabs.delete(tabId);
	try {
		await chrome.debugger.detach({ tabId });
	} catch {
		/* not attached or tab gone */
	}
}

export async function cdpSend<T = unknown>(
	tabId: number,
	method: string,
	params?: Record<string, unknown>,
): Promise<T> {
	await ensureAttached(tabId);
	return send<T>(tabId, method, params);
}

export interface ScreenshotOptions {
	/**
	 * Resize so the width is at most this many pixels. Without it the image is at CSS-pixel
	 * scale (capped at 1280 wide), so image coordinates are click coordinates.
	 */
	maxWidth?: number;
	fullPage?: boolean;
	/** Clip to this rectangle (CSS pixels, page coordinates). */
	clip?: { x: number; y: number; width: number; height: number };
	format?: "png" | "jpeg";
	quality?: number;
	/** Give up after this long; a hidden tab under load can take minutes to paint. */
	timeoutMs?: number;
}

const SCREENSHOT_TIMEOUT_MS = 20000;

/**
 * CSS pixels per screenshot pixel of each tab's last viewport screenshot. Agents read
 * coordinates off screenshots, so point-taking tools convert through this instead of
 * asking the model to do the arithmetic.
 */
const screenshotScale = new Map<number, number>();

export function screenshotToCss(tabId: number, p: { x: number; y: number }): { x: number; y: number } {
	const f = screenshotScale.get(tabId) ?? 1;
	return { x: p.x * f, y: p.y * f };
}
/** Chrome caps a single capture surface; taller full-page shots are cut here. */
const MAX_CAPTURE_HEIGHT = 16384;

interface LayoutMetrics {
	cssContentSize: { width: number; height: number };
	cssVisualViewport: { pageX: number; pageY: number; clientWidth: number; clientHeight: number };
}

/**
 * Screenshot of a tab, active or not. Returns base64 without the data URL prefix.
 *
 * The capture is scaled inside the renderer (clip.scale) instead of grabbing the full
 * device-pixel surface and shrinking it here: a 2x retina PNG of a large viewport is
 * several MB and dominated the time on a loaded machine. JPEG is the default for the
 * same reason. The call is bounded so a tab that never paints fails fast with a message
 * the model can act on instead of wedging the tool for a minute.
 */
export async function captureScreenshot(
	tabId: number,
	options: ScreenshotOptions = {},
): Promise<{
	data: string;
	mimeType: string;
	width: number;
	height: number;
	/** Size of the captured area in CSS pixels (the units click/drag/hover take). */
	cssWidth: number;
	cssHeight: number;
}> {
	await ensureAttached(tabId);
	const format = options.format ?? "jpeg";
	let css = { width: 0, height: 0 };
	const timeoutMs = options.timeoutMs ?? SCREENSHOT_TIMEOUT_MS;
	const capture = async () => {
		const metrics = await send<LayoutMetrics>(tabId, "Page.getLayoutMetrics");
		const vv = metrics.cssVisualViewport;
		let rect: { x: number; y: number; width: number; height: number };
		if (options.clip) rect = options.clip;
		else if (options.fullPage)
			rect = {
				x: 0,
				y: 0,
				width: metrics.cssContentSize.width,
				height: Math.min(metrics.cssContentSize.height, MAX_CAPTURE_HEIGHT),
			};
		else rect = { x: vv.pageX, y: vv.pageY, width: vv.clientWidth, height: vv.clientHeight };
		css = { width: rect.width, height: rect.height };
		// clip.scale is relative to CSS pixels: the image is rect.width * scale wide on any DPR.
		const maxWidth = options.maxWidth ?? Math.min(rect.width, 1280);
		const scale = rect.width > maxWidth ? maxWidth / rect.width : 1;
		const params: Record<string, unknown> = {
			format,
			fromSurface: true,
			optimizeForSpeed: true,
			captureBeyondViewport: options.fullPage === true || options.clip !== undefined,
			clip: { ...rect, scale },
		};
		if (format === "jpeg") params.quality = options.quality ?? 75;
		return (await send<{ data: string }>(tabId, "Page.captureScreenshot", params)).data;
	};
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(
			() =>
				reject(
					new Error(
						`Screenshot timed out after ${Math.round(timeoutMs / 1000)} s: the browser did not paint this background tab. ` +
							"Read the page with read_page / get_page_text instead, or retry.",
					),
				),
			timeoutMs,
		);
	});
	try {
		const data = await Promise.race([capture(), timeout]);
		const mimeType = format === "png" ? "image/png" : "image/jpeg";
		const img = await resizeImage(data, mimeType, options.maxWidth ?? Math.min(css.width, 1280));
		if (!options.clip && !options.fullPage && img.width > 0) screenshotScale.set(tabId, css.width / img.width);
		return { ...img, cssWidth: Math.round(css.width), cssHeight: Math.round(css.height) };
	} finally {
		clearTimeout(timer);
	}
}

async function resizeImage(
	base64: string,
	mimeType: string,
	maxWidth?: number,
): Promise<{ data: string; mimeType: string; width: number; height: number }> {
	const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
	const bitmap = await createImageBitmap(new Blob([bytes], { type: mimeType }));
	const scale = maxWidth && bitmap.width > maxWidth ? maxWidth / bitmap.width : 1;
	if (scale === 1) return { data: base64, mimeType, width: bitmap.width, height: bitmap.height };
	const width = Math.round(bitmap.width * scale);
	const height = Math.round(bitmap.height * scale);
	const canvas = new OffscreenCanvas(width, height);
	const ctx = canvas.getContext("2d");
	if (!ctx) throw new Error("Failed to get canvas context");
	ctx.drawImage(bitmap, 0, 0, width, height);
	const blob = await canvas.convertToBlob({ type: mimeType, quality: 0.85 });
	const buffer = new Uint8Array(await blob.arrayBuffer());
	let binary = "";
	for (let i = 0; i < buffer.length; i += 0x8000) {
		binary += String.fromCharCode(...buffer.subarray(i, i + 0x8000));
	}
	return { data: btoa(binary), mimeType, width, height };
}

// ---- Isolated world ---------------------------------------------------------------
//
// Without the userScripts toggle, sitegeist's own page code (snapshot, find, REPL) runs through
// the debugger. It runs in an isolated world named "sitegeist" that shares the DOM but not the
// page's JavaScript globals, the same isolation the userScripts path has: the page cannot see
// or call sitegeist's helpers, and a page that patches built-ins cannot break them.

export const ISOLATED_WORLD = "sitegeist";
const worldContexts = new Map<number, number>();
let worldListenerInstalled = false;

function installWorldListener(): void {
	if (worldListenerInstalled) return;
	worldListenerInstalled = true;
	// A new document gets a new world; the old context id is gone.
	chrome.webNavigation.onCommitted.addListener((d) => {
		if (d.frameId === 0) worldContexts.delete(d.tabId);
	});
	chrome.debugger.onDetach.addListener((source) => {
		if (source.tabId !== undefined) worldContexts.delete(source.tabId);
	});
	chrome.tabs.onRemoved.addListener((tabId) => worldContexts.delete(tabId));
}

async function isolatedContext(tabId: number): Promise<number> {
	installWorldListener();
	const known = worldContexts.get(tabId);
	if (known !== undefined) return known;
	const { frameTree } = await cdpSend<{ frameTree: { frame: { id: string } } }>(tabId, "Page.getFrameTree");
	const { executionContextId } = await send<{ executionContextId: number }>(tabId, "Page.createIsolatedWorld", {
		frameId: frameTree.frame.id,
		worldName: ISOLATED_WORLD,
	});
	worldContexts.set(tabId, executionContextId);
	return executionContextId;
}

export interface EvaluateResult<T> {
	result: { value?: T; description?: string; objectId?: string };
	exceptionDetails?: { exception?: { description?: string }; text?: string };
}

/** Runtime.evaluate in the tab's "sitegeist" isolated world (same DOM, separate globals). */
export async function evaluateIsolated<T = unknown>(
	tabId: number,
	expression: string,
	options: { returnByValue?: boolean; awaitPromise?: boolean } = {},
): Promise<EvaluateResult<T>> {
	const params = {
		expression,
		returnByValue: options.returnByValue ?? true,
		awaitPromise: options.awaitPromise ?? false,
	};
	try {
		return await send<EvaluateResult<T>>(tabId, "Runtime.evaluate", {
			...params,
			contextId: await isolatedContext(tabId),
		});
	} catch (err) {
		// The document changed between the lookup and the call (a navigation the listener has not seen yet).
		if (!/context/i.test(err instanceof Error ? err.message : String(err))) throw err;
		worldContexts.delete(tabId);
		return send<EvaluateResult<T>>(tabId, "Runtime.evaluate", { ...params, contextId: await isolatedContext(tabId) });
	}
}

// ---- Cross-origin iframes ----------------------------------------------------------
//
// A cross-origin iframe runs in its own renderer: commands on {tabId} never reach it, and
// page scripts in the top frame cannot read it. Target.setAutoAttach with flatten gives a
// child session per such frame, reachable through chrome.debugger with {tabId, sessionId}
// (Chrome 125+). Chrome applies the same URL checks to each child as to a tab.

const frameSessions = new Map<number, Set<string>>();
const autoAttached = new Set<number>();
let frameListenerInstalled = false;

function installFrameListener(): void {
	if (frameListenerInstalled) return;
	frameListenerInstalled = true;
	chrome.debugger.onEvent.addListener((source, method, params) => {
		if (source.tabId === undefined) return;
		const p = (params ?? {}) as { sessionId?: string; targetInfo?: { type?: string } };
		if (method === "Target.attachedToTarget" && p.sessionId && p.targetInfo?.type === "iframe") {
			const set = frameSessions.get(source.tabId) ?? new Set<string>();
			set.add(p.sessionId);
			frameSessions.set(source.tabId, set);
		} else if (method === "Target.detachedFromTarget" && p.sessionId) {
			frameSessions.get(source.tabId)?.delete(p.sessionId);
		}
	});
	chrome.debugger.onDetach.addListener((source) => {
		if (source.tabId === undefined) return;
		frameSessions.delete(source.tabId);
		autoAttached.delete(source.tabId);
	});
	chrome.tabs.onRemoved.addListener((tabId) => {
		frameSessions.delete(tabId);
		autoAttached.delete(tabId);
	});
}

async function ensureFrameSessions(tabId: number): Promise<void> {
	installFrameListener();
	await ensureAttached(tabId);
	if (autoAttached.has(tabId)) return;
	await send(tabId, "Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
	autoAttached.add(tabId);
	// attachedToTarget for frames that already exist arrives right after the call.
	await new Promise((r) => setTimeout(r, 150));
}

async function frameSend<T>(
	tabId: number,
	sessionId: string,
	method: string,
	params?: Record<string, unknown>,
): Promise<T> {
	return (await chrome.debugger.sendCommand({ tabId, sessionId }, method, params)) as T;
}

/** Evaluate in the first cross-origin iframe whose URL contains `match`. */
export async function evaluateInFrame<T = unknown>(tabId: number, match: string, expression: string): Promise<T> {
	await ensureFrameSessions(tabId);
	const seen: string[] = [];
	for (const sessionId of frameSessions.get(tabId) ?? []) {
		const href = await frameSend<{ result: { value?: string } }>(tabId, sessionId, "Runtime.evaluate", {
			expression: "location.href",
			returnByValue: true,
		}).catch(() => undefined);
		const url = href?.result.value ?? "";
		seen.push(url);
		if (!url.includes(match)) continue;
		const result = await frameSend<EvaluateResult<T>>(tabId, sessionId, "Runtime.evaluate", {
			expression,
			returnByValue: true,
			awaitPromise: true,
		});
		if (result.exceptionDetails)
			throw new Error(
				result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? "Evaluation failed",
			);
		return result.result.value as T;
	}
	throw new Error(
		seen.length
			? `No cross-origin iframe matches "${match}". Frames: ${seen.join(", ")}`
			: "This page has no cross-origin iframes; same-origin frames are reachable from the page itself (iframe.contentDocument).",
	);
}

/** Evaluate in the page's MAIN world and return the value (JSON-serialisable). */
export async function evaluateMain<T = unknown>(tabId: number, expression: string): Promise<T> {
	const result = await cdpSend<{
		result: { value?: T; description?: string };
		exceptionDetails?: { exception?: { description?: string }; text?: string };
	}>(tabId, "Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
	if (result.exceptionDetails) {
		throw new Error(
			result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? "Evaluation failed",
		);
	}
	return result.result.value as T;
}

export type MouseButton = "left" | "right" | "middle";

export async function click(
	tabId: number,
	x: number,
	y: number,
	options: { button?: MouseButton; clickCount?: number; modifiers?: number } = {},
): Promise<void> {
	const button = options.button ?? "left";
	const clickCount = options.clickCount ?? 1;
	const modifiers = options.modifiers ?? 0;
	await cdpSend(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y, modifiers });
	for (let i = 1; i <= clickCount; i++) {
		await send(tabId, "Input.dispatchMouseEvent", { type: "mousePressed", x, y, button, clickCount: i, modifiers });
		await send(tabId, "Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button, clickCount: i, modifiers });
	}
}

export async function hover(tabId: number, x: number, y: number): Promise<void> {
	await cdpSend(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
}

export async function drag(tabId: number, from: { x: number; y: number }, to: { x: number; y: number }): Promise<void> {
	await cdpSend(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x: from.x, y: from.y });
	await send(tabId, "Input.dispatchMouseEvent", {
		type: "mousePressed",
		x: from.x,
		y: from.y,
		button: "left",
		buttons: 1,
		clickCount: 1,
	});
	// Pointer-driven apps (canvas editors) read `buttons` on move to know the button is held.
	const steps = 12;
	for (let i = 1; i <= steps; i++) {
		const x = from.x + ((to.x - from.x) * i) / steps;
		const y = from.y + ((to.y - from.y) * i) / steps;
		await send(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "left", buttons: 1 });
	}
	await send(tabId, "Input.dispatchMouseEvent", {
		type: "mouseReleased",
		x: to.x,
		y: to.y,
		button: "left",
		clickCount: 1,
	});
}

export async function scroll(tabId: number, x: number, y: number, deltaX: number, deltaY: number): Promise<void> {
	await cdpSend(tabId, "Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX, deltaY });
}

/** Longer text than this goes in as one insertion when the focus is a text field. */
const INSERT_TEXT_FROM = 64;

async function focusTakesText(tabId: number): Promise<boolean> {
	const { result } = await send<{ result: { value?: boolean } }>(tabId, "Runtime.evaluate", {
		expression:
			"(() => { const e = document.activeElement; return !!e && (e.isContentEditable || e.tagName === 'TEXTAREA' || e.tagName === 'INPUT'); })()",
		returnByValue: true,
	});
	return result.value === true;
}

/**
 * Type text as key events (works in inputs, contenteditable, and for shortcuts). Each character
 * is two debugger round trips, so long text in a real text field is inserted line by line;
 * Enter stays a key press, which is what submits a form or starts a line in an editor.
 */
export async function typeText(tabId: number, text: string, options: { keys?: boolean } = {}): Promise<void> {
	await ensureAttached(tabId);
	if (!options.keys && text.length >= INSERT_TEXT_FROM && (await focusTakesText(tabId))) {
		const lines = text.split("\n");
		for (let i = 0; i < lines.length; i++) {
			if (lines[i]) await send(tabId, "Input.insertText", { text: lines[i] });
			if (i < lines.length - 1) await pressKey(tabId, "Enter");
		}
		return;
	}
	for (const char of text) {
		if (char === "\n") {
			await pressKey(tabId, "Enter");
			continue;
		}
		await send(tabId, "Input.dispatchKeyEvent", { type: "keyDown", text: char, key: char });
		await send(tabId, "Input.dispatchKeyEvent", { type: "keyUp", text: char, key: char });
	}
}

interface KeyInfo {
	key: string;
	code: string;
	keyCode: number;
	text?: string;
}

const KEY_MAP: Record<string, KeyInfo> = {
	Enter: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" },
	Tab: { key: "Tab", code: "Tab", keyCode: 9 },
	Escape: { key: "Escape", code: "Escape", keyCode: 27 },
	Backspace: { key: "Backspace", code: "Backspace", keyCode: 8 },
	Delete: { key: "Delete", code: "Delete", keyCode: 46 },
	ArrowUp: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
	ArrowDown: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
	ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
	ArrowRight: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
	Home: { key: "Home", code: "Home", keyCode: 36 },
	End: { key: "End", code: "End", keyCode: 35 },
	PageUp: { key: "PageUp", code: "PageUp", keyCode: 33 },
	PageDown: { key: "PageDown", code: "PageDown", keyCode: 34 },
	Space: { key: " ", code: "Space", keyCode: 32, text: " " },
	Shift: { key: "Shift", code: "ShiftLeft", keyCode: 16 },
	Control: { key: "Control", code: "ControlLeft", keyCode: 17 },
	Alt: { key: "Alt", code: "AltLeft", keyCode: 18 },
	Meta: { key: "Meta", code: "MetaLeft", keyCode: 91 },
	F1: { key: "F1", code: "F1", keyCode: 112 },
	F2: { key: "F2", code: "F2", keyCode: 113 },
	F3: { key: "F3", code: "F3", keyCode: 114 },
	F4: { key: "F4", code: "F4", keyCode: 115 },
	F5: { key: "F5", code: "F5", keyCode: 116 },
	F6: { key: "F6", code: "F6", keyCode: 117 },
	F7: { key: "F7", code: "F7", keyCode: 118 },
	F8: { key: "F8", code: "F8", keyCode: 119 },
	F9: { key: "F9", code: "F9", keyCode: 120 },
	F10: { key: "F10", code: "F10", keyCode: 121 },
	F11: { key: "F11", code: "F11", keyCode: 122 },
	F12: { key: "F12", code: "F12", keyCode: 123 },
};

const MODIFIER_BITS: Record<string, number> = { Alt: 1, Control: 2, Meta: 4, Shift: 8 };

/**
 * macOS runs Cmd and Option editing shortcuts through Cocoa key bindings, outside the
 * renderer, so a synthetic Meta+a selects nothing. Input.dispatchKeyEvent takes the editing
 * commands to run instead.
 */
const MAC_EDITING_COMMANDS: Record<string, string> = {
	"Meta+a": "selectAll",
	"Meta+c": "copy",
	"Meta+x": "cut",
	"Meta+v": "paste",
	"Meta+z": "undo",
	"Meta+Shift+z": "redo",
	"Meta+ArrowLeft": "moveToBeginningOfLine",
	"Meta+ArrowRight": "moveToEndOfLine",
	"Meta+ArrowUp": "moveToBeginningOfDocument",
	"Meta+ArrowDown": "moveToEndOfDocument",
	"Meta+Shift+ArrowLeft": "moveToBeginningOfLineAndModifySelection",
	"Meta+Shift+ArrowRight": "moveToEndOfLineAndModifySelection",
	"Meta+Shift+ArrowUp": "moveToBeginningOfDocumentAndModifySelection",
	"Meta+Shift+ArrowDown": "moveToEndOfDocumentAndModifySelection",
	"Meta+Backspace": "deleteToBeginningOfLine",
	"Alt+ArrowLeft": "moveWordLeft",
	"Alt+ArrowRight": "moveWordRight",
	"Alt+Shift+ArrowLeft": "moveWordLeftAndModifySelection",
	"Alt+Shift+ArrowRight": "moveWordRightAndModifySelection",
	"Alt+Backspace": "deleteWordBackward",
	"Alt+Delete": "deleteWordForward",
};

export const IS_MAC = typeof navigator !== "undefined" && /Mac OS X|Macintosh/.test(navigator.userAgent);

/** The editing commands a chord runs on macOS; empty elsewhere or for other chords. */
export function editingCommands(modifiers: number, key: string, mac = IS_MAC): string[] {
	if (!mac || modifiers & MODIFIER_BITS.Control) return [];
	const parts: string[] = [];
	if (modifiers & MODIFIER_BITS.Meta) parts.push("Meta");
	if (modifiers & MODIFIER_BITS.Alt) parts.push("Alt");
	if (modifiers & MODIFIER_BITS.Shift) parts.push("Shift");
	if (parts.length === 0) return [];
	const name = key.length === 1 ? key.toLowerCase() : key;
	const command = MAC_EDITING_COMMANDS[[...parts, name].join("+")];
	return command ? [command] : [];
}

export function keyInfo(name: string): KeyInfo {
	if (KEY_MAP[name]) return KEY_MAP[name];
	if (name.length === 1) {
		const upper = name.toUpperCase();
		const isLetter = /[A-Z]/.test(upper);
		const isDigit = /[0-9]/.test(name);
		return {
			key: name,
			code: isLetter ? `Key${upper}` : isDigit ? `Digit${name}` : "",
			keyCode: isLetter || isDigit ? upper.charCodeAt(0) : 0,
			text: name,
		};
	}
	return { key: name, code: name, keyCode: 0 };
}

/**
 * Press a key or chord such as "Enter", "Control+a", "Meta+Shift+p". Modifier names:
 * Control, Alt, Shift, Meta (also Cmd, Ctrl, Option as aliases).
 */
export async function pressKey(tabId: number, chord: string): Promise<void> {
	await ensureAttached(tabId);
	const parts = chord.split("+").map((p) => p.trim());
	const alias: Record<string, string> = { Cmd: "Meta", Command: "Meta", Ctrl: "Control", Option: "Alt", Win: "Meta" };
	const mods = parts.slice(0, -1).map((m) => alias[m] ?? m);
	const main = parts[parts.length - 1];
	let modifiers = 0;
	for (const m of mods) modifiers |= MODIFIER_BITS[m] ?? 0;
	for (const m of mods) {
		const info = keyInfo(m);
		await send(tabId, "Input.dispatchKeyEvent", {
			type: "rawKeyDown",
			...info,
			windowsVirtualKeyCode: info.keyCode,
			nativeVirtualKeyCode: info.keyCode,
			modifiers,
		});
	}
	const info = keyInfo(main);
	const base = {
		key: info.key,
		code: info.code,
		windowsVirtualKeyCode: info.keyCode,
		nativeVirtualKeyCode: info.keyCode,
		modifiers,
	};
	const commands = editingCommands(modifiers, info.key);
	await send(tabId, "Input.dispatchKeyEvent", {
		type: info.text && modifiers === 0 ? "keyDown" : "rawKeyDown",
		...base,
		...(info.text && modifiers === 0 ? { text: info.text } : {}),
		...(commands.length ? { commands } : {}),
	});
	await send(tabId, "Input.dispatchKeyEvent", { type: "keyUp", ...base });
	for (const m of mods.reverse()) {
		const minfo = keyInfo(m);
		await send(tabId, "Input.dispatchKeyEvent", {
			type: "keyUp",
			...minfo,
			windowsVirtualKeyCode: minfo.keyCode,
			nativeVirtualKeyCode: minfo.keyCode,
		});
	}
}

// ---------------------------------------------------------------------------
// Console and network capture (per tab ring buffers, on demand)
// ---------------------------------------------------------------------------

export interface ConsoleEntry {
	level: string;
	text: string;
	timestamp: number;
}

export interface NetworkEntry {
	requestId: string;
	method: string;
	url: string;
	status?: number;
	mimeType?: string;
	timestamp: number;
	failed?: string;
}

const MAX_ENTRIES = 300;
const consoleBuffers = new Map<number, ConsoleEntry[]>();
const networkBuffers = new Map<number, Map<string, NetworkEntry>>();
let captureListenerInstalled = false;

function installCaptureListener(): void {
	if (captureListenerInstalled) return;
	captureListenerInstalled = true;
	chrome.debugger.onEvent.addListener((source, method, params) => {
		const tabId = source.tabId;
		if (tabId === undefined) return;
		const p = (params ?? {}) as Record<string, unknown>;
		if (method === "Runtime.consoleAPICalled") {
			const buf = consoleBuffers.get(tabId);
			if (!buf) return;
			const args = (p.args as Array<{ value?: unknown; description?: string }>) ?? [];
			const text = args.map((a) => (a.value !== undefined ? String(a.value) : (a.description ?? ""))).join(" ");
			buf.push({ level: String(p.type ?? "log"), text, timestamp: Date.now() });
			if (buf.length > MAX_ENTRIES) buf.splice(0, buf.length - MAX_ENTRIES);
		} else if (method === "Runtime.exceptionThrown") {
			const buf = consoleBuffers.get(tabId);
			if (!buf) return;
			const details = p.exceptionDetails as { text?: string; exception?: { description?: string } } | undefined;
			buf.push({
				level: "error",
				text: details?.exception?.description ?? details?.text ?? "Uncaught exception",
				timestamp: Date.now(),
			});
		} else if (method === "Log.entryAdded") {
			// Browser-side messages: failed loads, CSP violations, interventions, deprecations.
			const buf = consoleBuffers.get(tabId);
			if (!buf) return;
			const entry = p.entry as { level?: string; source?: string; text?: string; url?: string };
			const where = entry.url ? ` (${entry.url})` : "";
			buf.push({
				level: String(entry.level ?? "info"),
				text: `[${entry.source ?? "browser"}] ${entry.text ?? ""}${where}`,
				timestamp: Date.now(),
			});
			if (buf.length > MAX_ENTRIES) buf.splice(0, buf.length - MAX_ENTRIES);
		} else if (method === "Network.requestWillBeSent") {
			const buf = networkBuffers.get(tabId);
			if (!buf) return;
			const request = p.request as { method: string; url: string };
			buf.set(String(p.requestId), {
				requestId: String(p.requestId),
				method: request.method,
				url: request.url,
				timestamp: Date.now(),
			});
			if (buf.size > MAX_ENTRIES) buf.delete(buf.keys().next().value as string);
		} else if (method === "Network.responseReceived") {
			const entry = networkBuffers.get(tabId)?.get(String(p.requestId));
			if (!entry) return;
			const response = p.response as { status: number; mimeType: string };
			entry.status = response.status;
			entry.mimeType = response.mimeType;
		} else if (method === "Network.loadingFailed") {
			const entry = networkBuffers.get(tabId)?.get(String(p.requestId));
			if (entry) entry.failed = String(p.errorText ?? "failed");
		}
	});
	chrome.tabs.onRemoved.addListener((tabId) => {
		consoleBuffers.delete(tabId);
		networkBuffers.delete(tabId);
	});
}

/** Start buffering console output for a tab (no-op if already on). */
export async function enableConsoleCapture(tabId: number): Promise<void> {
	installCaptureListener();
	if (consoleBuffers.has(tabId)) return;
	consoleBuffers.set(tabId, []);
	await cdpSend(tabId, "Runtime.enable");
	// Log.enable also replays what the browser logged before capture started.
	await cdpSend(tabId, "Log.enable").catch(() => undefined);
}

export function readConsole(tabId: number, clear = false): ConsoleEntry[] {
	const buf = consoleBuffers.get(tabId) ?? [];
	const out = [...buf];
	if (clear) buf.length = 0;
	return out;
}

/** Console messages as tools return them. */
export function consoleEntries(
	tabId: number,
	options: { onlyErrors?: boolean; pattern?: string; clear?: boolean; limit?: number },
): ConsoleEntry[] {
	let entries = readConsole(tabId, options.clear === true);
	if (options.onlyErrors) entries = entries.filter((e) => e.level === "error");
	if (options.pattern) {
		const re = new RegExp(options.pattern, "i");
		entries = entries.filter((e) => re.test(e.text));
	}
	return entries.slice(-(options.limit ?? 100));
}

export async function enableNetworkCapture(tabId: number): Promise<void> {
	installCaptureListener();
	if (networkBuffers.has(tabId)) return;
	networkBuffers.set(tabId, new Map());
	await cdpSend(tabId, "Network.enable");
	// Keep response bodies across cross-process navigations (Chrome 145+), so they can be read later.
	await cdpSend(tabId, "Network.configureDurableMessages", {}).catch(() => undefined);
}

const TEXT_MIME = /^(text\/|application\/(json|.*\+json|javascript|xml|.*\+xml|x-www-form-urlencoded|graphql))/i;

/** The response body of captured requests, text only, cut to maxChars each. */
export async function withResponseBodies(
	tabId: number,
	entries: NetworkEntry[],
	maxChars = 20000,
): Promise<Array<NetworkEntry & { body?: string }>> {
	const out: Array<NetworkEntry & { body?: string }> = [];
	for (const entry of entries) {
		if (entry.status === undefined || entry.failed) {
			out.push(entry);
			continue;
		}
		if (entry.mimeType && !TEXT_MIME.test(entry.mimeType)) {
			out.push({ ...entry, body: `[${entry.mimeType} body not shown]` });
			continue;
		}
		try {
			const r = await send<{ body: string; base64Encoded: boolean }>(tabId, "Network.getResponseBody", {
				requestId: entry.requestId,
			});
			const text = r.base64Encoded
				? new TextDecoder().decode(Uint8Array.from(atob(r.body), (c) => c.charCodeAt(0)))
				: r.body;
			out.push({
				...entry,
				body: text.length > maxChars ? `${text.slice(0, maxChars)}... [${text.length} chars]` : text,
			});
		} catch {
			out.push({ ...entry, body: "[body no longer available]" });
		}
	}
	return out;
}

export function readNetwork(tabId: number, clear = false): NetworkEntry[] {
	const buf = networkBuffers.get(tabId);
	if (!buf) return [];
	const out = [...buf.values()];
	if (clear) buf.clear();
	return out;
}

/** Network requests as tools return them. */
export function networkEntries(
	tabId: number,
	options: { urlPattern?: string; clear?: boolean; limit?: number },
): NetworkEntry[] {
	let entries = readNetwork(tabId, options.clear === true);
	if (options.urlPattern) {
		const re = new RegExp(options.urlPattern, "i");
		entries = entries.filter((e) => re.test(e.url));
	}
	return entries.slice(-(options.limit ?? 100));
}

// ---- Screencast --------------------------------------------------------------

export interface ScreencastOptions {
	format?: "jpeg" | "png";
	quality?: number;
	/** Device pixels; the frame is scaled down to fit inside both. */
	maxWidth?: number;
	maxHeight?: number;
	/** Upper bound on frames delivered per second; the ack is held back to meet it. */
	maxFps?: number;
	/** Main-world script run in every new document for as long as the cast lasts. */
	initScript?: string;
	/** Chrome draws click feedback into the page (157+), so a live view shows where the agent clicked. */
	showClicks?: boolean;
}

export interface ScreencastFrame {
	data: string;
	metadata: Record<string, unknown>;
}

interface Screencast {
	owner: string;
	sink: (frame: ScreencastFrame) => void;
	/** Told when the cast ends without being asked to (debugger detached, tab closed). */
	ended?: (reason: string) => void;
	minGapMs: number;
	lastAckAt: number;
	scriptId?: string;
	/** The init script, guarded to run once per document. */
	initScript?: string;
	showClicks?: boolean;
}

/**
 * Run once per document: a page restored from the back/forward cache keeps its old state
 * and gets no new-document scripts, so the cast evaluates this again on restore.
 */
function oncePerDocument(script: string): string {
	return `if (!window.__sitegeistCastInit) {\nwindow.__sitegeistCastInit = true;\n${script}\n}`;
}

/** Live casts by tab. A cast belongs to the client that started it; one per tab. */
const screencasts = new Map<number, Screencast>();
let screencastListenerInstalled = false;

function installScreencastListener(): void {
	if (screencastListenerInstalled) return;
	screencastListenerInstalled = true;
	chrome.debugger.onEvent.addListener((source, method, params) => {
		if (method === "Page.frameNavigated" && source.tabId !== undefined) {
			const p = params as { frame?: { parentId?: string }; type?: string };
			const cast = screencasts.get(source.tabId);
			if (cast?.initScript && !p.frame?.parentId && p.type === "BackForwardCacheRestore")
				send(source.tabId, "Runtime.evaluate", { expression: cast.initScript }).catch(() => undefined);
			return;
		}
		if (method !== "Page.screencastFrame" || source.tabId === undefined) return;
		const tabId = source.tabId;
		const cast = screencasts.get(tabId);
		const p = params as { data: string; metadata: Record<string, unknown>; sessionId: number };
		if (cast) cast.sink({ data: p.data, metadata: p.metadata });
		// With maxFramesInFlight 1, Chrome sends the next frame only after this ack, so holding it is the frame-rate cap.
		const wait = cast ? Math.max(0, cast.lastAckAt + cast.minGapMs - Date.now()) : 0;
		setTimeout(() => {
			if (cast) cast.lastAckAt = Date.now();
			send(tabId, "Page.screencastFrameAck", { sessionId: p.sessionId }).catch(() => undefined);
		}, wait);
	});
	chrome.debugger.onDetach.addListener((source, reason) => {
		if (source.tabId === undefined) return;
		const cast = screencasts.get(source.tabId);
		screencasts.delete(source.tabId);
		cast?.ended?.(`debugger detached: ${reason}`);
	});
	chrome.tabs.onRemoved.addListener((tabId) => {
		const cast = screencasts.get(tabId);
		screencasts.delete(tabId);
		cast?.ended?.("tab closed");
	});
}

/** Stream compositor frames of a tab, visible or not, to `sink` until stopped. */
export async function startScreencast(
	tabId: number,
	owner: string,
	options: ScreencastOptions,
	sink: (frame: ScreencastFrame) => void,
	ended?: (reason: string) => void,
): Promise<void> {
	installScreencastListener();
	await ensureAttached(tabId);
	if (screencasts.has(tabId)) await stopScreencast(tabId);
	const cast: Screencast = {
		owner,
		sink,
		ended,
		minGapMs: 1000 / Math.max(1, Math.min(60, options.maxFps ?? 30)),
		lastAckAt: 0,
	};
	screencasts.set(tabId, cast);
	await send(tabId, "Page.enable");
	if (options.initScript) {
		cast.initScript = oncePerDocument(options.initScript);
		const { identifier } = await send<{ identifier: string }>(tabId, "Page.addScriptToEvaluateOnNewDocument", {
			source: cast.initScript,
		});
		cast.scriptId = identifier;
		await send(tabId, "Runtime.evaluate", { expression: cast.initScript }).catch(() => undefined);
	}
	const format = options.format ?? "jpeg";
	await send(tabId, "Page.startScreencast", {
		format,
		...(format === "jpeg" ? { quality: options.quality ?? 80 } : {}),
		...(options.maxWidth ? { maxWidth: options.maxWidth } : {}),
		...(options.maxHeight ? { maxHeight: options.maxHeight } : {}),
		everyNthFrame: 1,
		// Chrome otherwise keeps three frames in flight and an animating page arrives at three times maxFps.
		// sendLastFrame delivers the newest frame when the held ack goes out (both 154+).
		maxFramesInFlight: 1,
		sendLastFrame: true,
	});
	if (options.showClicks) {
		cast.showClicks = true;
		await send(tabId, "Page.setInputVisualization", { clicks: true }).catch(() => undefined);
	}
}

export async function stopScreencast(tabId: number): Promise<boolean> {
	const cast = screencasts.get(tabId);
	if (!cast) return false;
	screencasts.delete(tabId);
	await send(tabId, "Page.stopScreencast").catch(() => undefined);
	if (cast.showClicks) await send(tabId, "Page.setInputVisualization", { clicks: false }).catch(() => undefined);
	if (cast.scriptId)
		await send(tabId, "Page.removeScriptToEvaluateOnNewDocument", { identifier: cast.scriptId }).catch(
			() => undefined,
		);
	return true;
}

/** Stop every cast a client started; its frames would have nowhere to go. */
export async function stopScreencastsOwnedBy(owner: string | undefined): Promise<void> {
	for (const [tabId, cast] of [...screencasts]) {
		if (owner !== undefined && cast.owner !== owner) continue;
		await stopScreencast(tabId);
		cast.ended?.("client disconnected");
	}
}
