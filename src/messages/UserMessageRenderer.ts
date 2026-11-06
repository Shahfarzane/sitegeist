import type { Attachment, MessageRenderer } from "@mariozechner/pi-web-ui";
import { registerMessageRenderer, type UserMessageWithAttachments } from "@mariozechner/pi-web-ui";
import { html, LitElement } from "lit";
import { customElement, property } from "lit/decorators.js";

/**
 * Custom user message component for Sitegeist with fancy pill styling.
 * Duplicates the web-ui UserMessage but with our custom styling.
 */
@customElement("sitegeist-user-message")
export class SitegeistUserMessage extends LitElement {
	@property({ type: Object }) message!: UserMessageWithAttachments;

	protected override createRenderRoot(): HTMLElement | DocumentFragment {
		return this;
	}

	override connectedCallback(): void {
		super.connectedCallback();
		this.style.display = "block";
	}

	override render() {
		const content =
			typeof this.message.content === "string"
				? this.message.content
				: (this.message.content.find((c) => c.type === "text") as { type: "text"; text: string } | undefined)
						?.text || "";

		return html`
			<div class="flex justify-end">
				<div class="user-message-container py-3 px-4 rounded-2xl">
					<markdown-block .content=${content}></markdown-block>
					${
						this.message.attachments && this.message.attachments.length > 0
							? html`
								<div class="mt-3 flex flex-wrap gap-2">
									${this.message.attachments.map(
										(attachment: Attachment) =>
											html` <attachment-tile .attachment=${attachment}></attachment-tile> `,
									)}
								</div>
							`
							: ""
					}
				</div>
			</div>
		`;
	}
}

export function createUserMessageRenderer(): MessageRenderer<UserMessageWithAttachments> {
	return {
		render: (message) => {
			return html`<sitegeist-user-message .message=${message}></sitegeist-user-message>`;
		},
	};
}

export function registerUserMessageRenderer() {
	registerMessageRenderer("user", createUserMessageRenderer());
}
