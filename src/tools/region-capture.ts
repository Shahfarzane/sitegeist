/**
 * Lets the user drag a rectangle on the page and attach that part of it to their message: "this
 * bit here" is often easier to show than to describe. The capture goes through the debugger:
 * chrome.tabs.captureVisibleTab needs <all_urls>, which this extension does not ask for.
 */

import type { Attachment } from "@mariozechner/pi-web-ui";
import { captureScreenshot } from "../browser/cdp.js";
import { injectScript } from "../browser/inject.js";

/** In CSS pixels of the page, scroll included. */
export interface Region {
	x: number;
	y: number;
	width: number;
	height: number;
}

/** Page-side: the selection overlay. Resolves with the region, or null on Escape. */
function pageSelectRegion(): Promise<Region | null> {
	return new Promise((resolve) => {
		const overlay = document.createElement("div");
		overlay.style.cssText =
			"position:fixed;inset:0;z-index:2147483647;cursor:crosshair;background:rgba(0,0,0,.25);user-select:none";
		const box = document.createElement("div");
		box.style.cssText =
			"position:fixed;display:none;border:2px solid #fff;box-shadow:0 0 0 9999px rgba(0,0,0,.35);pointer-events:none";
		const hint = document.createElement("div");
		hint.textContent = "Drag to select an area. Esc cancels.";
		hint.style.cssText =
			"position:fixed;top:16px;left:50%;transform:translateX(-50%);padding:6px 12px;border-radius:6px;background:#000;color:#fff;font:500 13px system-ui,sans-serif;pointer-events:none";
		overlay.append(box, hint);
		document.documentElement.append(overlay);

		let start: { x: number; y: number } | undefined;
		const rect = (e: MouseEvent) => {
			const from = start ?? { x: e.clientX, y: e.clientY };
			return {
				x: Math.min(from.x, e.clientX),
				y: Math.min(from.y, e.clientY),
				width: Math.abs(e.clientX - from.x),
				height: Math.abs(e.clientY - from.y),
			};
		};
		const finish = (region: Region | null) => {
			window.removeEventListener("keydown", onKey, true);
			window.removeEventListener("mouseup", onUp, true);
			overlay.remove();
			// Two frames: the overlay must be off the screen before the tab is captured.
			requestAnimationFrame(() => requestAnimationFrame(() => resolve(region)));
		};
		const onKey = (e: KeyboardEvent) => {
			if (e.key !== "Escape") return;
			e.preventDefault();
			e.stopPropagation();
			finish(null);
		};
		overlay.addEventListener("mousedown", (e) => {
			e.preventDefault();
			start = { x: e.clientX, y: e.clientY };
			hint.remove();
		});
		overlay.addEventListener("mousemove", (e) => {
			if (!start) return;
			const r = rect(e);
			Object.assign(box.style, {
				display: "block",
				left: `${r.x}px`,
				top: `${r.y}px`,
				width: `${r.width}px`,
				height: `${r.height}px`,
			});
		});
		// On the window: a drag that ends outside the page never reaches the overlay.
		const onUp = (e: MouseEvent) => {
			if (!start) return;
			const r = rect(e);
			finish(r.width < 4 || r.height < 4 ? null : { ...r, x: r.x + window.scrollX, y: r.y + window.scrollY });
		};
		window.addEventListener("mouseup", onUp, true);
		window.addEventListener("keydown", onKey, true);
	});
}

/** Let the user pick a region of the tab they see. Undefined when they cancel. */
export async function captureRegion(tabId: number): Promise<Attachment | undefined> {
	const region = await injectScript<Region | null>(tabId, `(${pageSelectRegion.toString()})()`);
	if (!region) return undefined;
	const shot = await captureScreenshot(tabId, { clip: region, format: "png" });
	return {
		id: crypto.randomUUID(),
		type: "image",
		fileName: "region.png",
		mimeType: "image/png",
		size: Math.round((shot.data.length * 3) / 4),
		content: shot.data,
		preview: shot.data,
	};
}
