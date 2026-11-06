import { Button } from "@mariozechner/mini-lit/dist/Button.js";
import { Input } from "@mariozechner/mini-lit/dist/Input.js";
import { SettingsTab } from "@mariozechner/pi-web-ui";
import { html, type TemplateResult } from "lit";
import { customElement, state } from "lit/decorators.js";
import { Toast } from "../components/Toast.js";
import type { ConnectorManager, ConnectorStatus } from "../connectors/manager.js";
import { parsePlugin, readPluginFolder } from "../connectors/plugins.js";
import { getSitegeistStorage } from "../storage/app-storage.js";
import type { Connector } from "../storage/stores/connectors-store.js";

/** Lets the panel hand over its manager without the tab reaching into it at import time. */
export interface ConnectorsTabHost {
	manager: ConnectorManager;
	/** Connectors changed: give the running agent the new tools. */
	refresh(): Promise<void>;
}

function describe(status: ConnectorStatus): string {
	switch (status.state) {
		case "connected":
			return `${status.tools} tool${status.tools === 1 ? "" : "s"}`;
		case "needs-login":
			return "Needs login";
		case "off":
			return "Off";
		default:
			return status.error && !/failed to fetch/i.test(status.error) ? status.error : "Could not reach this server";
	}
}

/** Settings > Connectors: MCP servers the panel agent can use, and plugins. */
@customElement("connectors-tab")
export class ConnectorsTab extends SettingsTab {
	host?: ConnectorsTabHost;
	@state() private statuses: ConnectorStatus[] = [];
	@state() private name = "";
	@state() private url = "";
	@state() private token = "";
	@state() private busy = false;

	getTabName(): string {
		return "Connectors";
	}

	override async connectedCallback() {
		super.connectedCallback();
		this.statuses = this.host?.manager.status ?? [];
		if (this.statuses.length === 0) await this.reload();
	}

	private async reload() {
		this.busy = true;
		try {
			await this.host?.refresh();
			this.statuses = this.host?.manager.status ?? [];
		} finally {
			this.busy = false;
		}
	}

	private async add() {
		const name = this.name.trim();
		const url = this.url.trim();
		if (!name || !/^https?:\/\//.test(url)) {
			Toast.error("A connector needs a name and an http(s) URL");
			return;
		}
		const token = this.token.trim();
		await getSitegeistStorage().connectors.save({
			name,
			kind: "remote",
			url,
			headers: token ? { Authorization: token.includes(" ") ? token : `Bearer ${token}` } : undefined,
			enabled: true,
			createdAt: new Date().toISOString(),
		});
		this.name = "";
		this.url = "";
		this.token = "";
		await this.reload();
	}

	private async setEnabled(connector: Connector, enabled: boolean) {
		await getSitegeistStorage().connectors.save({ ...connector, enabled });
		await this.reload();
	}

	private async removeConnector(connector: Connector) {
		await getSitegeistStorage().connectors.delete(connector.name);
		await this.reload();
	}

	private async login(connector: Connector) {
		this.busy = true;
		try {
			await this.host?.manager.login(connector);
			await this.reload();
		} catch (err) {
			Toast.error(err instanceof Error ? err.message : String(err));
		} finally {
			this.busy = false;
		}
	}

	private async installPlugin(input: HTMLInputElement) {
		if (!input.files?.length) return;
		const storage = getSitegeistStorage();
		try {
			const plugin = parsePlugin(await readPluginFolder(input.files));
			const prompts = new Set((await storage.prompts.list()).map((p) => p.name));
			const taken = [
				...(await Promise.all(plugin.skills.map(async (s) => ((await storage.skills.get(s.name)) ? s.name : "")))),
				...plugin.prompts.filter((p) => prompts.has(p.name)).map((p) => p.name),
				...(await Promise.all(
					plugin.connectors.map(async (c) => ((await storage.connectors.get(c.name)) ? c.name : "")),
				)),
			].filter(Boolean);
			if (taken.length > 0 && !confirm(`This plugin replaces what you have: ${taken.join(", ")}. Continue?`)) return;
			for (const skill of plugin.skills) await storage.skills.save(skill);
			for (const prompt of plugin.prompts) await storage.prompts.save(prompt);
			for (const connector of plugin.connectors) await storage.connectors.save(connector);
			const parts = [
				`${plugin.skills.length} skills`,
				`${plugin.prompts.length} prompts`,
				`${plugin.connectors.length} connectors`,
			];
			Toast.success(`${plugin.name}: ${parts.join(", ")}`);
			if (plugin.skippedLocalServers.length > 0) {
				Toast.show(
					`Local servers are not installed from a plugin: ${plugin.skippedLocalServers.join(", ")}. Add them with sitegeist connectors add.`,
					"info",
					8000,
				);
			}
			await this.reload();
		} catch (err) {
			Toast.error(`Not a plugin folder: ${err instanceof Error ? err.message : String(err)}`);
		} finally {
			input.value = "";
		}
	}

	private renderConnector(status: ConnectorStatus): TemplateResult {
		const { connector } = status;
		return html`
			<div class="flex items-center gap-2 p-3 rounded-lg border border-border">
				<input
					type="checkbox"
					aria-label="Use ${connector.name}"
					.checked=${connector.enabled}
					@change=${(e: Event) => this.setEnabled(connector, (e.target as HTMLInputElement).checked)}
				/>
				<div class="min-w-0 flex-1">
					<div class="text-sm font-medium text-foreground truncate">${connector.name}</div>
					<div class="text-xs text-muted-foreground truncate">
						${connector.kind === "local" ? "Local" : connector.url} · ${describe(status)}
					</div>
				</div>
				${
					status.state === "needs-login"
						? Button({ size: "sm", variant: "default", children: "Log in", onClick: () => this.login(connector) })
						: ""
				}
				${
					connector.kind === "remote"
						? Button({
								size: "sm",
								variant: "ghost",
								children: "Remove",
								onClick: () => this.removeConnector(connector),
							})
						: ""
				}
			</div>
		`;
	}

	render(): TemplateResult {
		return html`
			<div class="flex flex-col gap-6">
				<p class="text-sm text-muted-foreground">
					MCP servers the agent can use next to the browser. Add a remote server here. For a server that runs as a
					local command, use <code class="text-xs">sitegeist connectors add &lt;name&gt; -- &lt;command&gt;</code> on this
					computer; it then shows up here.
				</p>
				<div class="space-y-2">
					${
						this.statuses.length === 0
							? html`<div class="text-xs text-muted-foreground">${this.busy ? "Connecting..." : "No connectors yet."}</div>`
							: this.statuses.map((s) => this.renderConnector(s))
					}
				</div>
				<div class="space-y-2">
					<div class="text-sm font-medium text-foreground">Add a remote server</div>
					${Input({
						placeholder: "Name",
						value: this.name,
						className: "text-sm",
						onInput: (e: Event) => {
							this.name = (e.target as HTMLInputElement).value;
						},
					})}
					${Input({
						placeholder: "https://example.com/mcp",
						value: this.url,
						className: "text-sm",
						onInput: (e: Event) => {
							this.url = (e.target as HTMLInputElement).value;
						},
					})}
					${Input({
						placeholder: "Token (leave empty for OAuth or none)",
						type: "password",
						value: this.token,
						className: "text-sm",
						onInput: (e: Event) => {
							this.token = (e.target as HTMLInputElement).value;
						},
					})}
					${Button({ size: "sm", variant: "secondary", children: "Add", onClick: () => this.add() })}
				</div>
				<div class="space-y-2">
					<div class="text-sm font-medium text-foreground">Install a plugin</div>
					<p class="text-xs text-muted-foreground">
						Pick a Claude plugin folder. Its skills, commands and remote MCP servers are added.
					</p>
					<input
						type="file"
						webkitdirectory
						hidden
						id="plugin-folder"
						aria-label="Plugin folder"
						@change=${(e: Event) => this.installPlugin(e.target as HTMLInputElement)}
					/>
					${Button({
						size: "sm",
						variant: "secondary",
						children: "Choose folder",
						onClick: () => this.querySelector<HTMLInputElement>("#plugin-folder")?.click(),
					})}
				</div>
			</div>
		`;
	}
}
