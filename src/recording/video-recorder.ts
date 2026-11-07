/**
 * Video of a tab, encoded by Chrome itself (Page.startScreenRecording, Chrome 153+, AV1 in
 * MP4). The browser does the encoding, so nothing runs in the offscreen worker. Works on
 * hidden tabs while the debugger's focus emulation keeps them painting.
 */

import { cdpSend } from "../browser/cdp.js";

const recording = new Set<number>();
const MAX_VIDEO_BYTES = 40 * 1024 * 1024;

export function isRecordingVideo(tabId: number): boolean {
	return recording.has(tabId);
}

export async function startVideo(
	tabId: number,
	options: { frameRate?: number; maxWidth?: number } = {},
): Promise<void> {
	if (recording.has(tabId)) return;
	try {
		await cdpSend(tabId, "Page.startScreenRecording", {
			frameRate: options.frameRate ?? 15,
			maxWidth: options.maxWidth ?? 1280,
		});
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		throw new Error(
			/not supported/i.test(message)
				? "This browser cannot record video (Chrome builds it with AV1 since 153). Use gif_creator instead."
				: message,
		);
	}
	recording.add(tabId);
}

/** Stop and return the MP4 as base64. */
export async function stopVideo(tabId: number): Promise<{ data: string; mimeType: string; bytes: number }> {
	if (!recording.delete(tabId)) throw new Error("No video recording runs on this tab. Start one first.");
	const { stream } = await cdpSend<{ stream: string }>(tabId, "Page.stopScreenRecording");
	const parts: string[] = [];
	let bytes = 0;
	try {
		for (;;) {
			const chunk = await cdpSend<{ data: string; base64Encoded?: boolean; eof: boolean }>(tabId, "IO.read", {
				handle: stream,
				size: 1024 * 1024,
			});
			const binary = chunk.base64Encoded ? atob(chunk.data) : chunk.data;
			bytes += binary.length;
			if (bytes > MAX_VIDEO_BYTES) throw new Error("The video is larger than 40 MB. Record a shorter stretch.");
			parts.push(binary);
			if (chunk.eof) break;
		}
	} finally {
		await cdpSend(tabId, "IO.close", { handle: stream }).catch(() => undefined);
	}
	return { data: btoa(parts.join("")), mimeType: "video/mp4", bytes };
}

if (typeof chrome !== "undefined" && chrome.tabs?.onRemoved) {
	chrome.tabs.onRemoved.addListener((tabId) => recording.delete(tabId));
}
