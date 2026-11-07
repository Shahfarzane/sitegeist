/**
 * Renders the panel's screens at side panel size, light and dark, for a look before a release.
 *
 *   node scripts/e2e/screens.mjs <output-dir> [width]
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Browser, EXTENSION_ID, idbPutSource, openPanel, sendPrompt, startFakeServer } from "./lib.mjs";

const out = process.argv[2];
const width = Number(process.argv[3] ?? 400);
if (!out) throw new Error("usage: screens.mjs <output-dir> [width]");

const server = await startFakeServer({
	routes: { "/page": "<!doctype html><title>Fixture</title><h1>Fixture</h1>" },
	script: (_body, index) =>
		index % 2 === 0
			? { toolCalls: [{ name: "repl", args: { title: "Read the page", code: "return document.title;" } }] }
			: {
					text: "Done. The page lists three products, the cheapest is the [second one](https://example.com).\n\n```js\nconst cheapest = products.sort((a, b) => a.price - b.price)[0];\n```",
				},
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

const viewport = { width, height: 860, deviceScaleFactor: 2, mobile: false };

try {
	// Before any provider exists: the first run.
	const firstRun = await browser.open(`chrome-extension://${EXTENSION_ID}/sidepanel.html`);
	await firstRun.send("Emulation.setDeviceMetricsOverride", viewport);
	for (const theme of ["light", "dark"]) {
		await firstRun.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: theme }] });
		await firstRun.send("Page.reload");
		await firstRun.waitFor(`document.body.innerText.includes("Connect a provider")`);
		await shoot(firstRun, "first-run", theme);
	}
	await firstRun.send("Page.close");

	const context = await openPanel(browser, server);
	const { panel } = context;
	await panel.send("Emulation.setDeviceMetricsOverride", viewport);
	await panel.evaluate(`${idbPutSource}
		(async () => {
			await window.__idbPut("prompts", "summarize-page", { name: "summarize-page", text: "Summarize this page in five bullet points.", createdAt: "2026-01-01" });
			await window.__idbPut("connectors", "notes", { name: "notes", kind: "remote", url: "http://127.0.0.1:9/mcp", enabled: true, createdAt: "2026-01-01" });
			await window.__idbPut("connectors", "archive", { name: "archive", kind: "remote", url: "https://archive.example/mcp", enabled: false, createdAt: "2026-01-01" });
		})()`);
	for (const theme of ["light", "dark"]) {
		await panel.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: theme }] });
		await panel.send("Page.navigate", { url: `${context.url}&new=true` });
		await panel.waitFor(`!!document.querySelector(".welcome-mark")`);
		await shoot(panel, "welcome", theme);

		await click(panel, "fake-model");
		await shoot(panel, "models", theme);
		await panel.send("Page.navigate", { url: `${context.url}&new=true` });
		await panel.waitFor(`!!document.querySelector(".welcome-mark")`);

		await panel.evaluate(`(() => {
			const box = document.querySelector("message-editor textarea");
			box.focus();
			box.value = "/";
			box.dispatchEvent(new InputEvent("input", { bubbles: true }));
		})()`);
		await shoot(panel, "slash", theme);
		await panel.send("Page.navigate", { url: `${context.url}&new=true` });
		await panel.waitFor(`!!document.querySelector(".welcome-mark")`);

		await panel.evaluate(`document.querySelector("overflow-menu button").click()`);
		await shoot(panel, "menu", theme);
		await click(panel, "Settings");
		await panel.waitFor(`document.querySelectorAll("nav button").length > 5`);
		await shoot(panel, "settings", theme);
		for (const section of ["Notifications", "Downloads", "Prompts", "Connectors", "Bridge"]) {
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
		await shoot(panel, "chat", theme);
		const session = await panel.evaluate(`new URLSearchParams(location.search).get("session")`);
		await context.worker.evaluate(`chrome.storage.local.set({ ${JSON.stringify(`run.${session}`)}: 1 })`);
		await panel.send("Page.reload");
		await panel.waitFor(`document.body.innerText.includes("This task stopped")`);
		await shoot(panel, "resume", theme);
		await panel.evaluate(
			`[...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "Dismiss").click()`,
		);
		await panel.evaluate(`document.querySelector('button[title="Sessions"]').click()`);
		await shoot(panel, "sessions", theme);
	}
} finally {
	await browser.close();
	await server.close();
}
