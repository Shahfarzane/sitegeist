import { SettingsTab } from "@mariozechner/pi-web-ui";
import { html, type TemplateResult } from "lit";
import { customElement, state } from "lit/decorators.js";
import { Toast } from "../components/Toast.js";
import { downloadsGranted } from "../downloads/downloads.js";

/** Settings > Downloads: the optional `downloads` permission. */
@customElement("downloads-tab")
export class DownloadsTab extends SettingsTab {
	@state() private enabled = false;

	getTabName(): string {
		return "Downloads";
	}

	override async connectedCallback() {
		super.connectedCallback();
		this.enabled = await downloadsGranted();
	}

	private async toggle(input: HTMLInputElement) {
		try {
			// Must be the first await: the request needs this click's user gesture.
			const ok = input.checked
				? await chrome.permissions.request({ permissions: ["downloads"] })
				: await chrome.permissions.remove({ permissions: ["downloads"] });
			if (!ok) input.checked = !input.checked;
		} catch (err) {
			input.checked = !input.checked;
			Toast.error(err instanceof Error ? err.message : "Could not change downloads access");
		}
		this.enabled = await downloadsGranted();
	}

	render(): TemplateResult {
		return html`
			<div class="flex flex-col gap-6">
				<p class="text-sm text-muted-foreground">
					Let agents see the files pages download: name, folder, size and where they came from. Agents can then pick up a
					report or export a click saved. They see the list only; nothing is opened or deleted.
				</p>
				<label class="flex items-center gap-2 text-sm text-foreground">
					<input type="checkbox" .checked=${this.enabled} @change=${(e: Event) => this.toggle(e.target as HTMLInputElement)} />
					Show downloads to agents
				</label>
			</div>
		`;
	}
}
