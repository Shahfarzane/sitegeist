import { Button } from "@mariozechner/mini-lit/dist/Button.js";
import { SettingsTab } from "@mariozechner/pi-web-ui";
import { html, type TemplateResult } from "lit";
import { customElement, state } from "lit/decorators.js";
import { Toast } from "../components/Toast.js";
import { notifySettings, setNotifyEnabled, setNotifySound } from "../notify/notifications.js";

/** Settings > Notifications. */
@customElement("notifications-tab")
export class NotificationsTab extends SettingsTab {
	@state() private enabled = false;
	@state() private sound = true;

	getTabName(): string {
		return "Notifications";
	}

	override async connectedCallback() {
		super.connectedCallback();
		await this.load();
	}

	private async load() {
		const settings = await notifySettings();
		this.enabled = settings.granted && settings.enabled;
		this.sound = settings.sound;
	}

	private async toggle(input: HTMLInputElement) {
		if (input.checked) {
			try {
				// Must be the first await: the request needs this click's user gesture.
				const granted = await chrome.permissions.request({ permissions: ["notifications"] });
				if (!granted) {
					input.checked = false;
					return;
				}
			} catch (err) {
				input.checked = false;
				Toast.error(err instanceof Error ? err.message : "Could not turn on notifications");
				return;
			}
		}
		await setNotifyEnabled(input.checked);
		await this.load();
	}

	private test() {
		chrome.runtime.sendMessage({
			type: "sitegeist-notify",
			request: { kind: "done", title: "Sitegeist", message: "Notifications are working." },
		});
	}

	render(): TemplateResult {
		return html`
			<div class="flex flex-col gap-6">
				<p class="text-sm text-muted-foreground">
					Agents work in background tabs. Get a desktop notification when a task finishes, fails, or needs you.
					Clicking it opens the tab.
				</p>
				<label class="flex items-center gap-2 text-sm text-foreground">
					<input
						type="checkbox"
						.checked=${this.enabled}
						@change=${(e: Event) => this.toggle(e.target as HTMLInputElement)}
					/>
					Notify me
				</label>
				<label class="flex items-center gap-2 text-sm text-foreground ${this.enabled ? "" : "opacity-50"}">
					<input
						type="checkbox"
						.checked=${this.sound}
						?disabled=${!this.enabled}
						@change=${async (e: Event) => {
							await setNotifySound((e.target as HTMLInputElement).checked);
							await this.load();
						}}
					/>
					Play a sound
				</label>
				${
					this.enabled
						? html`<div>${Button({ size: "sm", variant: "secondary", children: "Send a test", onClick: () => this.test() })}</div>`
						: ""
				}
			</div>
		`;
	}
}
