import { icon } from "@mariozechner/mini-lit";
import { html, LitElement, type TemplateResult } from "lit";
import { property, state } from "lit/decorators.js";
import { Ellipsis, type IconNode, Monitor, Moon, Sun } from "lucide";
import { getTheme, setTheme, type ThemeChoice } from "../utils/theme.js";

export interface MenuAction {
	label: string;
	icon: IconNode;
	onSelect: () => void;
}

/** Entries are actions, separators, or the inline theme switch. */
export type MenuEntry = MenuAction | "separator" | "theme";

const THEMES: Array<{ value: ThemeChoice; label: string; icon: IconNode }> = [
	{ value: "light", label: "Light", icon: Sun },
	{ value: "dark", label: "Dark", icon: Moon },
	{ value: "system", label: "System", icon: Monitor },
];

/**
 * Header overflow menu: a trigger button and an anchored popover with role="menu".
 * Closes on outside pointer, Escape, Tab, or after an action; arrow keys move between items.
 * The `open` attribute is reflected so global shortcuts can tell the menu is up.
 */
export class OverflowMenu extends LitElement {
	@property({ attribute: false }) entries: MenuEntry[] = [];
	@property({ type: Boolean, reflect: true }) open = false;
	@state() private theme: ThemeChoice = getTheme();

	private onPointerDown = (e: PointerEvent) => {
		if (!this.contains(e.target as Node)) this.hide();
	};

	private onKeyDown = (e: KeyboardEvent) => {
		if (e.key === "Escape") {
			// Closing the menu must not also abort a running agent (sidepanel's Escape handler).
			e.stopImmediatePropagation();
			this.hide(true);
		} else if (e.key === "Tab") {
			this.hide();
		} else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
			e.preventDefault();
			this.moveFocus(e.key === "ArrowDown" ? 1 : -1);
		}
	};

	protected override createRenderRoot() {
		return this;
	}

	override disconnectedCallback() {
		super.disconnectedCallback();
		this.removeListeners();
	}

	private items(): HTMLElement[] {
		return [...this.querySelectorAll<HTMLElement>('[role="menuitem"], [role="menuitemradio"]')];
	}

	private moveFocus(step: number) {
		const items = this.items();
		const index = items.indexOf(document.activeElement as HTMLElement);
		const next = items[(index + step + items.length) % items.length];
		next?.focus();
	}

	private show(focusFirst: boolean) {
		this.theme = getTheme();
		this.open = true;
		document.addEventListener("pointerdown", this.onPointerDown, true);
		window.addEventListener("keydown", this.onKeyDown, true);
		if (focusFirst) this.updateComplete.then(() => this.items()[0]?.focus());
	}

	private hide(restoreFocus = false) {
		if (!this.open) return;
		this.open = false;
		this.removeListeners();
		if (restoreFocus) this.querySelector<HTMLElement>("[aria-haspopup]")?.focus();
	}

	private removeListeners() {
		document.removeEventListener("pointerdown", this.onPointerDown, true);
		window.removeEventListener("keydown", this.onKeyDown, true);
	}

	private renderEntry(entry: MenuEntry): TemplateResult {
		if (entry === "separator") return html`<div class="my-1 h-px bg-border" role="separator"></div>`;
		if (entry === "theme") {
			return html`
				<div class="flex items-center justify-between gap-2 px-2 py-1.5">
					<span class="text-sm text-foreground">Theme</span>
					<div class="flex rounded-md border border-border p-0.5" role="group" aria-label="Theme">
						${THEMES.map(
							(t) => html`
								<button
									role="menuitemradio"
									aria-checked=${this.theme === t.value}
									title=${t.label}
									aria-label=${t.label}
									class="p-1 rounded ${this.theme === t.value ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground"} focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
									@click=${() => {
										setTheme(t.value);
										this.theme = t.value;
									}}
								>
									${icon(t.icon, "xs")}
								</button>
							`,
						)}
					</div>
				</div>
			`;
		}
		return html`
			<button
				role="menuitem"
				class="flex w-full items-center gap-2 px-2 py-1.5 text-sm text-foreground rounded-md hover:bg-accent focus-visible:outline-none focus-visible:bg-accent"
				@click=${() => {
					this.hide();
					entry.onSelect();
				}}
			>
				<span class="text-muted-foreground">${icon(entry.icon, "sm")}</span>
				${entry.label}
			</button>
		`;
	}

	override render() {
		return html`
			<div class="relative">
				<button
					class="inline-flex items-center justify-center size-8 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${this.open ? "bg-accent text-foreground" : ""}"
					aria-haspopup="menu"
					aria-expanded=${this.open}
					aria-label="More"
					title="More"
					@click=${() => (this.open ? this.hide() : this.show(false))}
					@keydown=${(e: KeyboardEvent) => {
						if (!this.open && (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ")) {
							e.preventDefault();
							this.show(true);
						}
					}}
				>
					${icon(Ellipsis, "sm")}
				</button>
				${
					this.open
						? html`<div
								role="menu"
								class="absolute right-0 top-full mt-1 z-50 min-w-[208px] rounded-lg border border-border bg-popover p-1 shadow-lg"
							>
								${this.entries.map((entry) => this.renderEntry(entry))}
							</div>`
						: ""
				}
			</div>
		`;
	}
}

if (!customElements.get("overflow-menu")) {
	customElements.define("overflow-menu", OverflowMenu);
}
