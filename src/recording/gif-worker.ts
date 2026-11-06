/**
 * GIF encoder, in a worker of its own: all side panels share one renderer main thread, and
 * quantizing frames there would stall every running task.
 */

import { applyPalette, GIFEncoder, type GifEncoderInstance, quantize } from "gifenc";
import type { GifFrame, GifJobMessage, GifOptions, GifOverlay, GifWorkerReply } from "./gif-types.js";

const FORMAT = "rgb565";
/** A message between extension contexts tops out at 64 MiB, and base64 adds a third. */
const MAX_GIF_BYTES = 40 * 1024 * 1024;
const ACCENT = "#e8590c";
const ARROW = "#e03131";

let options: GifOptions = {};
let encoder: GifEncoderInstance | undefined;
let width = 0;
let height = 0;
let frames = 0;
/** Keeps frames in order: decoding is asynchronous. */
let queue: Promise<void> = Promise.resolve();

function reply(message: GifWorkerReply): void {
	(self as unknown as { postMessage(m: GifWorkerReply): void }).postMessage(message);
}

function colors(): number {
	const quality = options.quality ?? 10;
	if (quality <= 10) return 256;
	return quality <= 20 ? 128 : 64;
}

function drawClick(ctx: OffscreenCanvasRenderingContext2D, x: number, y: number): void {
	ctx.strokeStyle = ACCENT;
	ctx.lineWidth = 3;
	ctx.beginPath();
	ctx.arc(x, y, 14, 0, Math.PI * 2);
	ctx.stroke();
	ctx.fillStyle = ACCENT;
	ctx.beginPath();
	ctx.arc(x, y, 4, 0, Math.PI * 2);
	ctx.fill();
}

function drawArrow(ctx: OffscreenCanvasRenderingContext2D, x: number, y: number, toX: number, toY: number): void {
	const angle = Math.atan2(toY - y, toX - x);
	ctx.strokeStyle = ARROW;
	ctx.fillStyle = ARROW;
	ctx.lineWidth = 3;
	ctx.beginPath();
	ctx.moveTo(x, y);
	ctx.lineTo(toX, toY);
	ctx.stroke();
	ctx.beginPath();
	ctx.moveTo(toX, toY);
	ctx.lineTo(toX - 12 * Math.cos(angle - 0.45), toY - 12 * Math.sin(angle - 0.45));
	ctx.lineTo(toX - 12 * Math.cos(angle + 0.45), toY - 12 * Math.sin(angle + 0.45));
	ctx.closePath();
	ctx.fill();
}

function drawLabel(ctx: OffscreenCanvasRenderingContext2D, label: string): void {
	const size = Math.max(13, Math.round(width / 50));
	ctx.font = `600 ${size}px system-ui, sans-serif`;
	const text = label.length > 70 ? `${label.slice(0, 69)}...` : label;
	const textWidth = ctx.measureText(text).width;
	const pad = Math.round(size * 0.6);
	ctx.fillStyle = "rgba(0, 0, 0, 0.82)";
	ctx.fillRect(pad, pad, textWidth + pad * 2, size + pad * 1.4);
	ctx.fillStyle = "#ffffff";
	ctx.textBaseline = "middle";
	ctx.fillText(text, pad * 2, pad + (size + pad * 1.4) / 2);
}

function drawOverlays(ctx: OffscreenCanvasRenderingContext2D, frame: GifFrame): void {
	const scale = frame.viewportWidth > 0 ? width / frame.viewportWidth : 1;
	const at = (overlay: GifOverlay) => ({ x: overlay.x * scale, y: overlay.y * scale });
	for (const overlay of frame.overlays) {
		const { x, y } = at(overlay);
		if (overlay.kind === "click" && options.showClickIndicators !== false) drawClick(ctx, x, y);
		if (overlay.kind === "drag" && options.showDragPaths !== false) {
			drawArrow(ctx, x, y, (overlay.toX ?? overlay.x) * scale, (overlay.toY ?? overlay.y) * scale);
		}
	}
	if (frame.label && options.showActionLabels !== false) drawLabel(ctx, frame.label);
	if (options.showProgressBar !== false) {
		ctx.fillStyle = ACCENT;
		ctx.fillRect(0, height - 4, width * frame.progress, 4);
	}
}

async function encodeFrame(frame: GifFrame): Promise<void> {
	const bytes = Uint8Array.from(atob(frame.data), (c) => c.charCodeAt(0));
	const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/jpeg" }));
	if (!encoder) {
		const scale = Math.min(1, (options.maxWidth ?? 800) / bitmap.width);
		width = Math.round(bitmap.width * scale);
		height = Math.round(bitmap.height * scale);
		encoder = GIFEncoder();
	}
	const canvas = new OffscreenCanvas(width, height);
	const ctx = canvas.getContext("2d", { willReadFrequently: true });
	if (!ctx) throw new Error("No canvas context");
	ctx.drawImage(bitmap, 0, 0, width, height);
	bitmap.close();
	drawOverlays(ctx, frame);
	const rgba = ctx.getImageData(0, 0, width, height).data;
	const palette = quantize(rgba, colors(), { format: FORMAT });
	encoder.writeFrame(applyPalette(rgba, palette, FORMAT), width, height, {
		palette,
		delay: frame.delayMs,
		...(frames === 0 ? { repeat: 0 } : {}),
	});
	frames++;
}

function toBase64(bytes: Uint8Array): string {
	let binary = "";
	for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
	return btoa(binary);
}

self.onmessage = (event: MessageEvent<GifJobMessage>) => {
	const message = event.data;
	queue = queue
		.then(async () => {
			if (message.type === "start") options = message.options;
			else if (message.type === "frame") await encodeFrame(message.frame);
			else {
				if (!encoder) throw new Error("No frames to encode");
				encoder.finish();
				const bytes = encoder.bytes();
				if (bytes.length > MAX_GIF_BYTES)
					throw new Error("The GIF is too large; use a smaller maxWidth or a higher quality number");
				reply({
					type: "done",
					result: { data: toBase64(bytes), width, height, frames, bytes: bytes.length },
				});
			}
		})
		.catch((err: unknown) => reply({ type: "error", message: err instanceof Error ? err.message : String(err) }));
};
