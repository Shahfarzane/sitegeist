import { Button } from "@mariozechner/mini-lit/dist/Button.js";
import { Input } from "@mariozechner/mini-lit/dist/Input.js";
import { SettingsTab } from "@mariozechner/pi-web-ui";
import { html, type TemplateResult } from "lit";
import { customElement, state } from "lit/decorators.js";
import { Toast } from "../components/Toast.js";
import { getSitegeistStorage } from "../storage/app-storage.js";
import type { SavedPrompt } from "../storage/stores/prompts-store.js";

/** Settings > Prompts: reusable prompts for the `/` menu. */
@customElement("prompts-tab")
export class PromptsTab extends SettingsTab {
	@state() private prompts: SavedPrompt[] = [];
	@state() private name = "";
	@state() private text = "";
	/** The prompt being edited, so a rename replaces it instead of adding a second one. */
	private editing?: string;

	getTabName(): string {
		return "Prompts";
	}

	override async connectedCallback() {
		super.connectedCallback();
		await this.load();
	}

	private async load() {
		this.prompts = await getSitegeistStorage().prompts.list();
	}

	private async save() {
		const name = this.name.trim().replace(/\s+/g, "-");
		const text = this.text.trim();
		if (!name || !text) {
			Toast.error("A prompt needs a name and text");
			return;
		}
		const prompts = getSitegeistStorage().prompts;
		if (name !== this.editing && this.prompts.some((p) => p.name === name)) {
			Toast.error(`A prompt named ${name} already exists`);
			return;
		}
		await prompts.save({ name, text, createdAt: new Date().toISOString() });
		if (this.editing && this.editing !== name) await prompts.delete(this.editing);
		this.editing = undefined;
		this.name = "";
		this.text = "";
		await this.load();
	}

	private edit(prompt: SavedPrompt) {
		this.editing = prompt.name;
		this.name = prompt.name;
		this.text = prompt.text;
	}

	render(): TemplateResult {
		return html`
			<div class="flex flex-col gap-6">
				<p class="text-sm text-muted-foreground">
					Prompts you use often. Type <code class="text-xs">/</code> in the chat to insert one.
				</p>
				<div class="space-y-2">
					${Input({
						placeholder: "Name, e.g. summarize-page",
						value: this.name,
						className: "text-sm",
						onInput: (e: Event) => {
							this.name = (e.target as HTMLInputElement).value;
						},
					})}
					<textarea
						class="w-full min-h-24 rounded-md border border-input bg-transparent px-3 py-2 text-sm text-foreground"
						placeholder="Summarize this page in five bullet points."
						.value=${this.text}
						@input=${(e: Event) => {
							this.text = (e.target as HTMLTextAreaElement).value;
						}}
					></textarea>
					${Button({ size: "sm", variant: "secondary", children: "Save prompt", onClick: () => this.save() })}
				</div>
				<div class="space-y-2">
					${
						this.prompts.length === 0
							? html`<div class="text-xs text-muted-foreground">No saved prompts yet.</div>`
							: this.prompts.map(
									(p) => html`
										<div class="flex items-start justify-between gap-2 p-3 rounded-lg border border-border">
											<button class="min-w-0 flex-1 text-left" @click=${() => this.edit(p)} title="Edit">
												<div class="text-sm font-medium text-foreground">/${p.name}</div>
												<div class="text-xs text-muted-foreground truncate">${p.text}</div>
											</button>
											${Button({
												size: "sm",
												variant: "ghost",
												children: "Remove",
												onClick: async () => {
													await getSitegeistStorage().prompts.delete(p.name);
													await this.load();
												},
											})}
										</div>
									`,
								)
					}
				</div>
			</div>
		`;
	}
}
