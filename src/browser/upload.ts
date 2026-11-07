/**
 * File upload through Chrome itself, for files that exist on this machine. Needs the extension's
 * "Allow access to file URLs" toggle: DOM.setFileInputFiles and file drags are refused without it.
 * Against the page-script path it has no size cap, fires trusted events, and can answer an upload
 * button's native file picker (Page.setInterceptFileChooserDialog) instead of avoiding it.
 */

import { cdpSend, click, ensureAttached } from "./cdp.js";
import { type ElementTarget, resolverSource, runInPage } from "./page.js";

export function fileAccessAllowed(): Promise<boolean> {
	return new Promise((resolve) => {
		try {
			chrome.extension.isAllowedFileSchemeAccess((allowed) => resolve(allowed === true));
		} catch {
			resolve(false);
		}
	});
}

const MARK = "data-sitegeist-upload";
const CHOOSER_WAIT_MS = 1500;

/**
 * Mark the target in whatever world holds the snapshot refs (attributes are shared between
 * worlds), so the debugger can find the same element. Prefers the file input behind a label,
 * an upload button in a form, or a wrapper, like the page-script path.
 */
function pageMarkTarget(
	resolve: (target: ElementTarget) => Element,
	target: ElementTarget,
	point: { x: number; y: number } | null,
	mark: string,
	id: string,
): { kind: "input" | "element"; x: number; y: number } {
	const named = target.ref || target.selector || target.text;
	const el = point
		? document.elementFromPoint(point.x, point.y)
		: named
			? resolve(target)
			: document.querySelector("input[type=file]");
	if (!el) throw new Error("No file input on this page. Name a drop target with ref, selector, text or x/y.");
	const fileInput = (c: Element | null | undefined) => (c instanceof HTMLInputElement && c.type === "file" ? c : null);
	const labelFor = el instanceof HTMLLabelElement ? el.control : null;
	const formInput = el.matches("button,[role=button],a")
		? el.closest("form")?.querySelector<HTMLInputElement>("input[type=file]")
		: null;
	const input =
		fileInput(el) ??
		fileInput(labelFor) ??
		el.querySelector<HTMLInputElement>("input[type=file]") ??
		el.closest("label")?.querySelector<HTMLInputElement>("input[type=file]") ??
		formInput;
	const chosen = input ?? el;
	chosen.setAttribute(mark, id);
	if (!input) el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
	const r = el.getBoundingClientRect();
	return {
		kind: input ? "input" : "element",
		x: point?.x ?? r.left + r.width / 2,
		y: point?.y ?? r.top + r.height / 2,
	};
}

async function markedObject(tabId: number, id: string): Promise<string> {
	const { result } = await cdpSend<{ result: { objectId?: string } }>(tabId, "Runtime.evaluate", {
		expression: `(() => { const el = document.querySelector('[${MARK}="${id}"]'); if (el) el.removeAttribute("${MARK}"); return el; })()`,
	});
	if (!result.objectId) throw new Error("The upload target left the page; take a new snapshot");
	return result.objectId;
}

function waitForChooser(tabId: number): { opened: Promise<number | undefined>; stop: () => void } {
	let listener: ((source: chrome.debugger.Debuggee, method: string, params?: object) => void) | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const opened = new Promise<number | undefined>((resolve) => {
		listener = (source, method, params) => {
			if (source.tabId !== tabId || method !== "Page.fileChooserOpened") return;
			resolve((params as { backendNodeId?: number }).backendNodeId);
		};
		chrome.debugger.onEvent.addListener(listener);
		timer = setTimeout(() => resolve(undefined), CHOOSER_WAIT_MS);
	});
	const stop = () => {
		if (listener) chrome.debugger.onEvent.removeListener(listener);
		clearTimeout(timer);
	};
	return { opened, stop };
}

/** Hand local files to a file input, an upload button's picker, or a drop zone. */
export async function uploadPaths(
	tabId: number,
	target: ElementTarget,
	paths: string[],
	point?: { x: number; y: number },
): Promise<{ delivered: "input" | "chooser" | "drop"; files: number }> {
	await ensureAttached(tabId);
	const id = crypto.randomUUID();
	const marked = await runInPage<{ kind: "input" | "element"; x: number; y: number }>(
		tabId,
		`(() => {
			${resolverSource(target)}
			return (${pageMarkTarget.toString()})(resolve, target, ${JSON.stringify(point ?? null)}, ${JSON.stringify(MARK)}, ${JSON.stringify(id)});
		})()`,
	);
	const objectId = await markedObject(tabId, id);
	if (marked.kind === "input") {
		await cdpSend(tabId, "DOM.setFileInputFiles", { files: paths, objectId });
		return { delivered: "input", files: paths.length };
	}
	// An upload button opens the native picker: let Chrome hand it to us instead.
	await cdpSend(tabId, "Page.setInterceptFileChooserDialog", { enabled: true });
	const chooser = waitForChooser(tabId);
	try {
		await click(tabId, marked.x, marked.y);
		const backendNodeId = await chooser.opened;
		if (backendNodeId !== undefined) {
			await cdpSend(tabId, "DOM.setFileInputFiles", { files: paths, backendNodeId });
			return { delivered: "chooser", files: paths.length };
		}
	} finally {
		chooser.stop();
		await cdpSend(tabId, "Page.setInterceptFileChooserDialog", { enabled: false }).catch(() => undefined);
	}
	// No picker: a drop zone. Chrome drags the real files in, with trusted drag events.
	const data = { items: [], files: paths, dragOperationsMask: 1 };
	for (const type of ["dragEnter", "dragOver", "drop"] as const) {
		await cdpSend(tabId, "Input.dispatchDragEvent", { type, x: marked.x, y: marked.y, data });
	}
	return { delivered: "drop", files: paths.length };
}
