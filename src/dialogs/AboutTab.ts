import { i18n } from "@mariozechner/mini-lit/dist/i18n.js";
import { SettingsTab } from "@mariozechner/pi-web-ui";
import { html, type TemplateResult } from "lit";
import { customElement } from "lit/decorators.js";
import "../utils/i18n-extension.js";

@customElement("about-tab")
export class AboutTab extends SettingsTab {
	getTabName(): string {
		return i18n("About");
	}

	render(): TemplateResult {
		// Releases carry "1.2.250 (abc1234)" as version_name: the build and the commit it came from.
		const manifest = chrome.runtime.getManifest();
		const version = manifest.version_name ?? manifest.version;

		return html`
			<div class="flex flex-col gap-4">
				<div class="space-y-2">
					<h3 class="text-lg font-semibold text-foreground">Sitegeist</h3>
					<p class="text-sm text-muted-foreground">${i18n("AI-powered browser extension for web navigation and interaction")}</p>
				</div>

				<div class="space-y-1">
					<div class="text-sm">
						<span class="font-medium text-foreground">${i18n("Version:")}</span>
						<span class="text-muted-foreground ml-2">${version}</span>
					</div>
				</div>

				<p class="text-xs text-muted-foreground">
					Private build. New signed releases install automatically from your release folder
					(<code>scripts/release-crx.sh</code>).
				</p>

				<div class="pt-4 space-y-2">
					<div class="text-xs text-muted-foreground space-x-3">
						<a href="https://sitegeist.ai" target="_blank" class="text-primary hover:underline">${i18n("Website")}</a>
						<span>·</span>
						<a href="https://sitegeist.ai/imprint" target="_blank" class="text-primary hover:underline">${i18n("Imprint")}</a>
						<span>·</span>
						<a href="https://sitegeist.ai/privacy" target="_blank" class="text-primary hover:underline">${i18n("Privacy")}</a>
					</div>
				</div>
			</div>
		`;
	}
}
