/**
 * Records what an agent does in a tab as an animated GIF: compositor frames from a screencast,
 * plus the actions on top (click markers, drag arrows, labels), so a recording explains itself.
 * Works on hidden tabs. Encoding happens in the offscreen document's worker.
 */

import { captureScreenshot, startScreencast, stopScreencast } from "../browser/cdp.js";
import type { BrowserSession } from "../browser/session.js";
import { ensureOffscreen } from "../notify/notifications.js";
import {
	GIF_PORT,
	type GifFrame,
	type GifJobMessage,
	type GifOptions,
	type GifOverlay,
	type GifResult,
	type GifWorkerReply,
} from "./gif-types.js";

const MAX_FPS = 4;
const MAX_FRAMES = 200;
const FRAME_WIDTH = 1000;
const MIN_DELAY_MS = 120;
/** Idle stretches are cut down: nobody wants to watch a page do nothing. */
const MAX_DELAY_MS = 1500;
const LAST_FRAME_MS = 1800;
/** A click marker stays this long, so it survives into a frame. */
const OVERLAY_MS = 900;
const EXPORT_TIMEOUT_MS = 240000;

export interface GifAction {
	kind: "click" | "drag" | "label";
	x?: number;
	y?: number;
	toX?: number;
	toY?: number;
	label?: string;
}

interface CapturedFrame {
	data: string;
	at: number;
	/** CSS width of the page in this frame: resize_window can change it mid-recording. */
	viewportWidth: number;
}

export class GifRecorder {
	private frames: CapturedFrame[] = [];
	private actions: Array<GifAction & { at: number }> = [];
	private tabId?: number;
	private viewportWidth = 0;

	/** The client whose disconnect ends a running cast. */
	private owner = "panel";

	get recording(): boolean {
		return this.tabId !== undefined;
	}

	get frameCount(): number {
		return this.frames.length;
	}

	private keep(data: string, viewportWidth: number): void {
		this.viewportWidth = viewportWidth;
		this.frames.push({ data, at: Date.now(), viewportWidth });
		// Past the cap every other frame goes: the whole recording stays covered.
		if (this.frames.length > MAX_FRAMES) this.frames = this.frames.filter((_f, i) => i % 2 === 0);
	}

	private async still(tabId: number): Promise<void> {
		const shot = await captureScreenshot(tabId, { maxWidth: FRAME_WIDTH, format: "jpeg", quality: 70 });
		this.keep(shot.data, shot.cssWidth);
	}

	/** Start or follow the agent to another tab; frames add to the same recording. */
	async start(tabId: number, owner = "panel"): Promise<void> {
		if (this.tabId === tabId) return;
		if (this.tabId !== undefined) await stopScreencast(this.tabId);
		this.tabId = undefined;
		this.owner = owner;
		await this.still(tabId);
		await startScreencast(
			tabId,
			this.owner,
			{ format: "jpeg", quality: 60, maxWidth: FRAME_WIDTH, maxFps: MAX_FPS },
			(frame) => this.keep(frame.data, Number(frame.metadata.deviceWidth) || this.viewportWidth),
			() => {
				if (this.tabId === tabId) this.tabId = undefined;
			},
		);
		this.tabId = tabId;
	}

	note(action: GifAction): void {
		if (this.recording) this.actions.push({ ...action, at: Date.now() });
	}

	async stop(): Promise<void> {
		const tabId = this.tabId;
		if (tabId === undefined) return;
		this.tabId = undefined;
		await stopScreencast(tabId);
		// The screencast only sends changes, so the end state may not have a frame yet.
		await this.still(tabId).catch(() => undefined);
	}

	clear(): void {
		this.frames = [];
		this.actions = [];
	}

	private timeline(): GifFrame[] {
		const start = this.frames[0]?.at ?? 0;
		const span = Math.max(1, (this.frames.at(-1)?.at ?? start) - start);
		return this.frames.map((frame, index) => {
			const next = this.frames[index + 1];
			const delayMs = next ? Math.min(MAX_DELAY_MS, Math.max(MIN_DELAY_MS, next.at - frame.at)) : LAST_FRAME_MS;
			const overlays: GifOverlay[] = [];
			let label: string | undefined;
			for (const action of this.actions) {
				const until = next?.at ?? frame.at;
				if (action.at > until) break;
				if (action.label) label = action.label;
				if (action.kind === "label" || action.x === undefined || action.y === undefined) continue;
				if (until - action.at > OVERLAY_MS) continue;
				overlays.push({ kind: action.kind, x: action.x, y: action.y, toX: action.toX, toY: action.toY });
			}
			return {
				data: frame.data,
				delayMs,
				overlays,
				label,
				progress: (frame.at - start) / span,
				viewportWidth: frame.viewportWidth,
			};
		});
	}

	/** Encode what was recorded. Frames stay, so an export can be repeated with other options. */
	async export(options: GifOptions): Promise<GifResult> {
		if (this.recording) await this.stop();
		if (this.frames.length === 0) throw new Error("Nothing recorded. Use start_recording first.");
		await ensureOffscreen();
		const port = chrome.runtime.connect({ name: GIF_PORT });
		try {
			let timer: ReturnType<typeof setTimeout> | undefined;
			const done = new Promise<GifResult>((resolve, reject) => {
				timer = setTimeout(() => reject(new Error("GIF encoding timed out")), EXPORT_TIMEOUT_MS);
				port.onMessage.addListener((message: GifWorkerReply) => {
					if (message.type === "done") resolve(message.result);
					else reject(new Error(`GIF encoding failed: ${message.message}`));
				});
				port.onDisconnect.addListener(() => reject(new Error("The GIF encoder went away")));
			}).finally(() => clearTimeout(timer));
			const send = (message: GifJobMessage) => port.postMessage(message);
			send({ type: "start", options });
			for (const frame of this.timeline()) send({ type: "frame", frame });
			send({ type: "finish" });
			return await done;
		} finally {
			port.disconnect();
		}
	}
}

/**
 * One recorder per agent session, by instance: a chat's session gets its real id on first save,
 * which can happen in the middle of a recording.
 */
const recorders = new WeakMap<BrowserSession, GifRecorder>();

export function gifRecorderFor(session: BrowserSession): GifRecorder {
	let recorder = recorders.get(session);
	if (!recorder) {
		recorder = new GifRecorder();
		recorders.set(session, recorder);
	}
	return recorder;
}

/** Note an action for the session's recording, if there is one. */
export function noteGifAction(session: BrowserSession, action: GifAction): void {
	recorders.get(session)?.note(action);
}
