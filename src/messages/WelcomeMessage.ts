import type { Agent } from "@mariozechner/pi-agent-core";
import type { AgentInterface, MessageRenderer } from "@mariozechner/pi-web-ui";
import { registerMessageRenderer } from "@mariozechner/pi-web-ui";
import { html, LitElement, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import "../components/OrbAnimation.js";

export interface TutorialPrompt {
	label: string;
	prompt: string;
}

export interface WelcomeMessage {
	role: "welcome";
	tutorials: TutorialPrompt[];
}

/** First-run hooks: whether any provider is connected, and the flow that connects one. */
export interface WelcomeOnboarding {
	hasProvider: () => Promise<boolean>;
	connect: () => Promise<void>;
}

declare module "@mariozechner/pi-agent-core" {
	interface CustomAgentMessages {
		welcome: WelcomeMessage;
	}
}

@customElement("welcome-message")
export class WelcomeMessageElement extends LitElement {
	@property({ type: Array }) tutorials!: TutorialPrompt[];
	@property({ attribute: false }) agent!: Agent;
	@property({ attribute: false }) agentInterface!: AgentInterface;
	@property({ attribute: false }) message!: WelcomeMessage;
	@property({ attribute: false }) onboarding?: WelcomeOnboarding;
	// Unknown until checked, so the connect prompt does not flash for configured users.
	@state() private needsProvider: boolean | undefined;

	protected createRenderRoot() {
		return this;
	}

	private async checkProvider() {
		this.needsProvider = this.onboarding ? !(await this.onboarding.hasProvider()) : false;
	}

	private async connect() {
		await this.onboarding?.connect();
		await this.checkProvider();
	}

	override connectedCallback() {
		super.connectedCallback();
		void this.checkProvider();
	}

	private async selectTutorial(prompt: string) {
		// Remove this welcome message
		const messages = this.agent.state.messages.filter((m) => m !== this.message);
		this.agent.replaceMessages(messages);

		// Send tutorial prompt
		await this.agentInterface.sendMessage(prompt);
	}

	/** Fills the chat area: the mark stays centered, and whatever arrives below it moves nothing. */
	override render(): TemplateResult {
		return html`
			<div class="absolute inset-0 grid grid-cols-[minmax(0,1fr)] grid-rows-[1fr_auto_1fr] overflow-y-auto">
				<div></div>
				<div class="welcome-mark flex flex-col items-center gap-6 px-4 text-center">
					<orb-animation></orb-animation>
					<p class="max-w-xs text-xs text-muted-foreground">
						Sitegeist works on the current page and any tab you share with it.
					</p>
				</div>
				<div class="flex flex-col justify-end min-w-0 w-full max-w-3xl mx-auto">
					${
						this.needsProvider === undefined
							? ""
							: this.needsProvider
								? html`
										<div class="flex flex-col items-center gap-4 px-4 pb-4">
											<p class="max-w-xs text-center text-sm text-muted-foreground">
												Connect a model provider (a Claude, ChatGPT, Copilot or Gemini subscription, or an API key) to get started.
											</p>
											<button
												class="inline-flex items-center h-9 px-4 rounded-full text-sm font-medium bg-primary text-primary-foreground hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
												@click=${() => this.connect()}
											>
												Connect a provider
											</button>
										</div>
									`
								: this.tutorials.length === 0
									? ""
									: html`
										<div
											class="welcome-suggestions flex gap-2 px-4 pb-2 overflow-x-auto"
											@wheel=${(e: WheelEvent) => {
												(e.currentTarget as HTMLElement).scrollLeft += e.deltaY;
											}}
										>
											${this.tutorials.map(
												(tutorial) => html`
													<button
														class="tutorial-pill shrink-0 h-8 px-3 text-sm text-foreground rounded-full cursor-pointer"
														@click=${() => this.selectTutorial(tutorial.prompt)}
													>
														${tutorial.label}
													</button>
												`,
											)}
										</div>
									`
					}
				</div>
			</div>
		`;
	}
}

export function createWelcomeRenderer(
	agent: Agent,
	agentInterface: AgentInterface,
	onboarding?: WelcomeOnboarding,
): MessageRenderer<WelcomeMessage> {
	return {
		render: (message) => {
			// Only show if no conversation started yet
			const hasConversation = agent.state.messages.some(
				(m) => m.role === "user" || m.role === "user-with-attachments" || m.role === "assistant",
			);

			if (hasConversation) return html``;

			return html`<welcome-message
				.tutorials=${message.tutorials}
				.agent=${agent}
				.agentInterface=${agentInterface}
				.message=${message}
				.onboarding=${onboarding}
			></welcome-message>`;
		},
	};
}

export function registerWelcomeRenderer(agent: Agent, agentInterface: AgentInterface, onboarding?: WelcomeOnboarding) {
	registerMessageRenderer("welcome", createWelcomeRenderer(agent, agentInterface, onboarding));
}

export function createWelcomeMessage(tutorials: TutorialPrompt[]): WelcomeMessage {
	return { role: "welcome", tutorials };
}
