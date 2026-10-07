/**
 * Light / dark / system theme. Same storage as mini-lit's ThemeToggle and
 * static/theme-loader.js: localStorage "theme" holds "light" or "dark"; absent means system.
 */
export type ThemeChoice = "light" | "dark" | "system";

const media = window.matchMedia("(prefers-color-scheme: dark)");

export function getTheme(): ThemeChoice {
	const stored = localStorage.getItem("theme");
	return stored === "light" || stored === "dark" ? stored : "system";
}

function apply(choice: ThemeChoice): void {
	const dark = choice === "dark" || (choice === "system" && media.matches);
	document.documentElement.classList.toggle("dark", dark);
}

export function setTheme(choice: ThemeChoice): void {
	if (choice === "system") localStorage.removeItem("theme");
	else localStorage.setItem("theme", choice);
	apply(choice);
}

/** Follow OS appearance changes while the choice is "system". */
export function watchSystemTheme(): void {
	media.addEventListener("change", () => {
		if (getTheme() === "system") apply("system");
	});
}
