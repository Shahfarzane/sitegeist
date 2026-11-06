/// <reference path="./utils/i18n-extension.ts" />

declare module "gifenc" {
	export type GifPalette = number[][];
	export interface GifEncoderInstance {
		writeFrame(
			index: Uint8Array,
			width: number,
			height: number,
			options?: { palette?: GifPalette; delay?: number; repeat?: number; first?: boolean },
		): void;
		finish(): void;
		bytes(): Uint8Array;
	}
	export function GIFEncoder(options?: { auto?: boolean }): GifEncoderInstance;
	export function quantize(rgba: Uint8ClampedArray, maxColors: number, options?: { format?: string }): GifPalette;
	export function applyPalette(rgba: Uint8ClampedArray, palette: GifPalette, format?: string): Uint8Array;
}
