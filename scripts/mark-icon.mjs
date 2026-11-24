// The dev channel's icons: the production icon with a green dot in its bottom right corner, so
// the two copies are told apart in the toolbar and on the extensions page. Drawn at build time
// from static/icon-*.png, so no second set of images is kept. Reads and writes 8-bit RGBA PNGs
// only, which is what static/ holds; anything else fails the build instead of passing unmarked.

import { crc32, deflateSync, inflateSync } from "node:zlib";

const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const GREEN = [0x22, 0xc5, 0x5e];
const WHITE = [0xff, 0xff, 0xff];

/** Pixels of an 8-bit RGBA, non-interlaced PNG, four bytes per pixel, rows top to bottom. */
export function decodePng(png) {
	if (!png.subarray(0, 8).equals(SIGNATURE)) throw new Error("not a PNG");
	let ihdr;
	const idat = [];
	for (let offset = 8; offset < png.length; ) {
		const length = png.readUInt32BE(offset);
		const type = png.toString("latin1", offset + 4, offset + 8);
		const data = png.subarray(offset + 8, offset + 8 + length);
		if (type === "IHDR") ihdr = data;
		else if (type === "IDAT") idat.push(data);
		else if (type === "IEND") break;
		offset += 12 + length;
	}
	if (!ihdr) throw new Error("PNG without IHDR");
	const width = ihdr.readUInt32BE(0);
	const height = ihdr.readUInt32BE(4);
	const [depth, colorType, , , interlace] = ihdr.subarray(8, 13);
	if (depth !== 8 || colorType !== 6 || interlace !== 0) {
		throw new Error(
			`expected an 8-bit RGBA PNG without interlace (depth ${depth}, color ${colorType}, interlace ${interlace})`,
		);
	}
	const raw = inflateSync(Buffer.concat(idat));
	const stride = width * 4;
	const pixels = Buffer.alloc(stride * height);
	for (let y = 0; y < height; y++) {
		const filter = raw[y * (stride + 1)];
		const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
		const row = pixels.subarray(y * stride, (y + 1) * stride);
		const up = y > 0 ? pixels.subarray((y - 1) * stride, y * stride) : undefined;
		for (let x = 0; x < stride; x++) {
			const a = x >= 4 ? row[x - 4] : 0;
			const b = up ? up[x] : 0;
			const c = up && x >= 4 ? up[x - 4] : 0;
			let predictor;
			if (filter === 0) predictor = 0;
			else if (filter === 1) predictor = a;
			else if (filter === 2) predictor = b;
			else if (filter === 3) predictor = (a + b) >> 1;
			else if (filter === 4) {
				const p = a + b - c;
				const pa = Math.abs(p - a);
				const pb = Math.abs(p - b);
				const pc = Math.abs(p - c);
				predictor = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
			} else throw new Error(`unknown PNG filter ${filter}`);
			row[x] = (line[x] + predictor) & 0xff;
		}
	}
	return { width, height, pixels };
}

function chunk(type, data) {
	const head = Buffer.alloc(8);
	head.writeUInt32BE(data.length, 0);
	head.write(type, 4, "latin1");
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0);
	return Buffer.concat([head, data, crc]);
}

/** An 8-bit RGBA PNG of the pixels, every row unfiltered. */
export function encodePng({ width, height, pixels }) {
	const stride = width * 4;
	const raw = Buffer.alloc((stride + 1) * height);
	for (let y = 0; y < height; y++) pixels.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	ihdr[8] = 8;
	ihdr[9] = 6;
	return Buffer.concat([
		SIGNATURE,
		chunk("IHDR", ihdr),
		chunk("IDAT", deflateSync(raw)),
		chunk("IEND", Buffer.alloc(0)),
	]);
}

const clamp = (v) => Math.min(1, Math.max(0, v));

/** Paints an opaque color over the pixel at `i` with coverage `alpha` (straight alpha, as PNG stores it). */
function paint(pixels, i, color, alpha) {
	const below = pixels[i + 3] / 255;
	const out = alpha + below * (1 - alpha);
	for (let k = 0; k < 3; k++) {
		pixels[i + k] = Math.round((color[k] * alpha + pixels[i + k] * below * (1 - alpha)) / out);
	}
	pixels[i + 3] = Math.round(out * 255);
}

/** The icon with the dev mark: a green dot in a white ring, in the bottom right corner. */
export function markIcon(png) {
	const image = decodePng(png);
	const { width, height, pixels } = image;
	const radius = Math.min(width, height) * 0.28;
	const ring = Math.max(1, Math.min(width, height) / 16);
	const cx = width - radius;
	const cy = height - radius;
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
			const coverage = clamp(radius - d + 0.5);
			if (coverage === 0) continue;
			const fill = clamp(radius - ring - d + 0.5);
			const color = WHITE.map((w, k) => Math.round(w * (1 - fill) + GREEN[k] * fill));
			paint(pixels, (y * width + x) * 4, color, coverage);
		}
	}
	return encodePng(image);
}
