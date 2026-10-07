import { icon } from "@mariozechner/mini-lit";
import { DialogBase } from "@mariozechner/mini-lit/dist/DialogBase.js";
import type { SettingsTab } from "@mariozechner/pi-web-ui";
import { html } from "lit";
import { state } from "lit/decorators.js";
import { ChevronLeft, ChevronRight } from "lucide";

export interface SettingsSection {
	label: string;
	hint: string;
	tab: SettingsTab;
}

/**
 * Settings as a list of sections you drill into, sized for a narrow side panel (a tab strip
 * of seven sections does not fit at 400px). Tabs stay mounted while the sheet is open, so a
 * section keeps its state when you go back and return. Esc goes back one level, then closes.
 */
export class SettingsSheet extends DialogBase {
	@state() private selected: number | undefined;
	private sections: SettingsSection[] = [];
	private onClosed?: () => void;
	private boundBack = (e: KeyboardEvent) => {
		if (e.key !== "Escape" || this.selected === undefined) return;
		// Capture phase on window runs before the dialog's own Escape handlers.
		e.stopImmediatePropagation();
		this.selected = undefined;
	};

	protected modalWidth = "min(720px, 90vw)";
	protected modalHeight = "min(760px, 90vh)";

	static open(sections: SettingsSection[], options: { section?: string; onClose?: () => void } = {}): SettingsSheet {
		const sheet = new SettingsSheet();
		sheet.sections = sections;
		sheet.onClosed = options.onClose;
		const index = sections.findIndex((s) => s.label === options.section);
		sheet.selected = index >= 0 ? index : undefined;
		sheet.open();
		return sheet;
	}

	override open() {
		window.addEventListener("keydown", this.boundBack, true);
		super.open();
	}

	override close() {
		window.removeEventListener("keydown", this.boundBack, true);
		super.close();
		this.onClosed?.();
		this.onClosed = undefined;
	}

	private renderList() {
		return html`
			<nav class="flex flex-col">
				${this.sections.map(
					(section, index) => html`
						<button
							class="flex items-center gap-3 px-4 py-3 text-left border-b border-border last:border-b-0 hover:bg-accent focus-visible:outline-none focus-visible:bg-accent"
							@click=${() => {
								this.selected = index;
							}}
						>
							<span class="flex-1 min-w-0">
								<span class="block text-sm font-medium text-foreground">${section.label}</span>
								<span class="block text-xs text-muted-foreground truncate">${section.hint}</span>
							</span>
							<span class="text-muted-foreground">${icon(ChevronRight, "sm")}</span>
						</button>
					`,
				)}
			</nav>
		`;
	}

	protected renderContent() {
		const current = this.selected === undefined ? undefined : this.sections[this.selected];
		return html`
			<div class="flex flex-col h-full min-h-0">
				<header class="flex items-center gap-1 h-12 pl-2 pr-12 border-b border-border shrink-0">
					${
						current
							? html`<button
									class="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent"
									aria-label="Back to settings"
									@click=${() => {
										this.selected = undefined;
									}}
								>
									${icon(ChevronLeft, "sm")}
								</button>`
							: ""
					}
					<h2 class="text-sm font-semibold text-foreground ${current ? "" : "pl-2"}">${current?.label ?? "Settings"}</h2>
				</header>
				<div class="flex-1 min-h-0 overflow-y-auto">
					<div style="display: ${current ? "none" : "block"}">${this.renderList()}</div>
					${this.sections.map(
						(section, index) =>
							html`<div class="p-4" style="display: ${this.selected === index ? "block" : "none"}">${section.tab}</div>`,
					)}
				</div>
			</div>
		`;
	}
}

if (!customElements.get("settings-sheet")) {
	customElements.define("settings-sheet", SettingsSheet);
}
