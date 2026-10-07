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

	private taglineWords = ["automate", "write", "transform", "research", "scrape", "create"];
	private currentWordIndex = 0;
	private intervalId?: number;

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
		// Rotate tagline word every 2 seconds
		this.intervalId = window.setInterval(() => {
			this.currentWordIndex = (this.currentWordIndex + 1) % this.taglineWords.length;
			this.requestUpdate();
		}, 2000);
	}

	override disconnectedCallback() {
		super.disconnectedCallback();
		if (this.intervalId) {
			clearInterval(this.intervalId);
		}
	}

	private async selectTutorial(prompt: string) {
		// Remove this welcome message
		const messages = this.agent.state.messages.filter((m) => m !== this.message);
		this.agent.replaceMessages(messages);

		// Send tutorial prompt
		await this.agentInterface.sendMessage(prompt);
	}

	override render(): TemplateResult {
		return html`
			<div class="welcome-orb-container my-6 flex flex-col items-center justify-center text-center">
				<h1 class="text-2xl font-semibold tracking-tight text-foreground">Sitegeist</h1>
				<p class="mt-1 text-sm text-muted-foreground">
					Your AI companion for the web to
					<span class="rotating-word inline-block min-w-[72px] text-left font-medium text-foreground" key=${this.currentWordIndex}
						>${this.taglineWords[this.currentWordIndex]}</span
					>
				</p>

				<div class="flex items-center justify-center my-2">
					<orb-animation></orb-animation>
				</div>

				${
					this.needsProvider === undefined
						? ""
						: this.needsProvider
							? html`
									<p class="text-sm text-muted-foreground max-w-xs">
										Connect a model provider (a Claude, ChatGPT, Copilot or Gemini subscription, or an API key) to get started.
									</p>
									<button
										class="mt-4 inline-flex items-center h-9 px-4 rounded-md text-sm font-medium bg-primary text-primary-foreground hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
										@click=${() => this.connect()}
									>
										Connect a provider
									</button>
								`
							: html`
									<div class="flex flex-wrap gap-2 justify-center max-w-sm px-4">
										${this.tutorials.map(
											(tutorial) => html`
												<button
													class="tutorial-pill px-3 py-1.5 text-xs font-medium text-foreground rounded-full cursor-pointer"
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
			const hasConversation = agent.state.messages.some((m) => m.role === "user" || m.role === "assistant");

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
