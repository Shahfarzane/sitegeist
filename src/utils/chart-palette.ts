/**
 * Grayscale series colors for charts, so they follow the monochrome theme: dark to light
 * on a light background, light to dark on a dark one. Canvas accepts oklch() strings.
 */
export function chartPalette(count: number): string[] {
	const dark = document.documentElement.classList.contains("dark");
	const [from, to] = dark ? [0.92, 0.42] : [0.25, 0.8];
	const n = Math.max(count, 1);
	return Array.from({ length: n }, (_, i) => {
		const l = n === 1 ? from : from + ((to - from) * i) / (n - 1);
		return `oklch(${l.toFixed(3)} 0 0)`;
	});
}
