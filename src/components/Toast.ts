import { icon } from "@mariozechner/mini-lit";
import { html, LitElement } from "lit";
import { customElement, property } from "lit/decorators.js";
import { AlertCircle, CheckCircle, X } from "lucide";

type ToastType = "success" | "error" | "info";

@customElement("toast-notification")
export class Toast extends LitElement {
	@property() message = "";
	@property() type: ToastType = "info";
	@property() duration = 3000;
	@property({ type: Boolean }) isExiting = false;

	private timeoutId?: number;

	connectedCallback() {
		super.connectedCallback();
		// Auto-dismiss after duration
		if (this.duration > 0) {
			this.timeoutId = window.setTimeout(() => this.dismiss(), this.duration);
		}
	}

	disconnectedCallback() {
		super.disconnectedCallback();
		if (this.timeoutId) {
			clearTimeout(this.timeoutId);
		}
	}

	dismiss() {
		this.isExiting = true;
		this.requestUpdate();
		setTimeout(() => this.remove(), 300);
	}

	render() {
		const iconEl =
			this.type === "success"
				? icon(CheckCircle, "sm")
				: this.type === "error"
					? icon(AlertCircle, "sm")
					: icon(AlertCircle, "sm");

		const tone = this.type === "error" ? "text-destructive" : "text-foreground";

		return html`
			<div class="fixed top-4 right-4 z-[9999] ${this.isExiting ? "animate-out slide-out-to-right duration-300" : "animate-in slide-in-from-right duration-300"}">
				<div class="min-w-[240px] max-w-[360px] flex items-center gap-3 px-3 py-2.5 bg-popover text-popover-foreground rounded-lg shadow-lg border border-border">
					<span class=${tone}>${iconEl}</span>
					<span class="flex-1 text-sm font-medium">${this.message}</span>
					<button
						@click=${() => this.dismiss()}
						class="text-muted-foreground hover:text-foreground hover:bg-accent rounded p-1"
					>
						${icon(X, "sm")}
					</button>
				</div>
			</div>
		`;
	}

	createRenderRoot() {
		return this;
	}

	/**
	 * Static method to show a toast notification
	 */
	static show(message: string, type: ToastType = "info", duration = 3000) {
		const toast = document.createElement("toast-notification") as Toast;
		toast.message = message;
		toast.type = type;
		toast.duration = duration;
		document.body.appendChild(toast);
		return toast;
	}

	static success(message: string, duration = 3000) {
		return Toast.show(message, "success", duration);
	}

	static error(message: string, duration = 5000) {
		return Toast.show(message, "error", duration);
	}
}
