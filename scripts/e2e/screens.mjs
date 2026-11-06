/**
 * Renders the panel's screens at side panel size, light and dark, for a look before a release.
 *
 *   node scripts/e2e/screens.mjs <output-dir>
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Browser, idbPutSource, openPanel, sendPrompt, startFakeServer } from "./lib.mjs";

const out = process.argv[2];
if (!out) throw new Error("usage: screens.mjs <output-dir>");

const server = await startFakeServer({
	routes: { "/page": "<!doctype html><title>Fixture</title><h1>Fixture</h1>" },
	script: () => ({ text: "Done. The page lists three products, the cheapest is the second one." }),
});
const browser = await Browser.launch();

async function shoot(panel, name, theme) {
	await new Promise((r) => setTimeout(r, 350));
	const data = await panel.screenshot();
	writeFileSync(join(out, `${name}-${theme}.png`), Buffer.from(data, "base64"));
}

const click = (panel, text, scope = "button,[role=menuitem]") =>
	panel.evaluate(
		`[...document.querySelectorAll(${JSON.stringify(scope)})].find((b) => b.textContent.includes(${JSON.stringify(text)})).click()`,
	);

try {
	const context = await openPanel(browser, server);
	const { panel } = context;
	await panel.send("Emulation.setDeviceMetricsOverride", {
		width: 400,
		height: 860,
		deviceScaleFactor: 2,
		mobile: false,
	});
	await panel.evaluate(`${idbPutSource}
		(async () => {
			await window.__idbPut("prompts", "summarize-page", { name: "summarize-page", text: "Summarize this page in five bullet points.", createdAt: "2026-01-01" });
			await window.__idbPut("connectors", "notes", { name: "notes", kind: "remote", url: "http://127.0.0.1:9/mcp", enabled: true, createdAt: "2026-01-01" });
			await window.__idbPut("connectors", "archive", { name: "archive", kind: "remote", url: "https://archive.example/mcp", enabled: false, createdAt: "2026-01-01" });
		})()`);
	for (const theme of ["light", "dark"]) {
		await panel.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: theme }] });
		await panel.send("Page.navigate", { url: `${context.url}&new=true` });
		await panel.waitFor(`document.body.innerText.includes("Summarize this page")`);
		await shoot(panel, "welcome", theme);

		await panel.evaluate(`document.querySelector("overflow-menu button").click()`);
		await shoot(panel, "menu", theme);
		await click(panel, "Settings");
		await panel.waitFor(`document.querySelectorAll("nav button").length > 5`);
		await shoot(panel, "settings", theme);
		for (const section of ["Notifications", "Prompts", "Connectors", "Bridge"]) {
			await click(panel, section, "nav button");
			await new Promise((r) => setTimeout(r, section === "Connectors" ? 1500 : 200));
			await shoot(panel, section.toLowerCase(), theme);
			await panel.evaluate(`document.querySelector('[aria-label="Back to settings"]').click()`);
		}
		await panel.send("Page.navigate", { url: `${context.url}&new=true` });
		await panel.waitFor(`!!document.querySelector("message-editor textarea")`);
		await sendPrompt(panel, "What is on this page?");
		await panel.waitFor(`document.body.innerText.includes("cheapest")`);
		await panel.waitFor(`location.search.includes("session=")`);
		const session = await panel.evaluate(`new URLSearchParams(location.search).get("session")`);
		await context.worker.evaluate(`chrome.storage.local.set({ ${JSON.stringify(`run.${session}`)}: 1 })`);
		await panel.send("Page.reload");
		await panel.waitFor(`document.body.innerText.includes("This task stopped")`);
		await shoot(panel, "resume", theme);
		await panel.evaluate(
			`[...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "Dismiss").click()`,
		);
	}
} finally {
	await browser.close();
	await server.close();
}
