/** What the recorder, the offscreen document and the encoder worker exchange. */

export interface GifOptions {
	/** Output width in pixels. */
	maxWidth?: number;
	showClickIndicators?: boolean;
	showDragPaths?: boolean;
	showActionLabels?: boolean;
	showProgressBar?: boolean;
	/** 1 to 30, lower is better and larger. */
	quality?: number;
}

export interface GifOverlay {
	kind: "click" | "drag";
	/** CSS pixels of the page. */
	x: number;
	y: number;
	toX?: number;
	toY?: number;
}

export interface GifFrame {
	/** Base64 JPEG. */
	data: string;
	delayMs: number;
	overlays: GifOverlay[];
	label?: string;
	/** 0 to 1, for the progress bar. */
	progress: number;
	/** CSS width of the page in this frame; overlays scale from it. */
	viewportWidth: number;
}

export interface GifResult {
	/** Base64 GIF. */
	data: string;
	width: number;
	height: number;
	frames: number;
	bytes: number;
}

export type GifJobMessage =
	| { type: "start"; options: GifOptions }
	| { type: "frame"; frame: GifFrame }
	| { type: "finish" };

export type GifWorkerReply = { type: "done"; result: GifResult } | { type: "error"; message: string };

export const GIF_PORT = "sitegeist-gif-encoder";
