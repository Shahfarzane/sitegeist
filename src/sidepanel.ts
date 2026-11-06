import { icon } from "@mariozechner/mini-lit";
import { Button } from "@mariozechner/mini-lit/dist/Button.js";
import { Input } from "@mariozechner/mini-lit/dist/Input.js";
import {
	Agent,
	type AgentEvent,
	type AgentMessage,
	type AgentState,
	type AgentTool,
} from "@mariozechner/pi-agent-core";
import { getModel, getModels, type Model, type TextContent } from "@mariozechner/pi-ai";
import {
	ChatPanel,
	createExtractDocumentTool,
	createStreamFn,
	ModelSelector,
	ProxyTab,
	// PersistentStorageDialog,
	setAppStorage,
	setShowJsonMode,
} from "@mariozechner/pi-web-ui";
import { html, render, type TemplateResult } from "lit";
import { Circle, Download, History, Link, Plus, Settings, Square } from "lucide";
import type { Compaction } from "./agent/context.js";
import { SUMMARY_SYSTEM_PROMPT } from "./agent/context.js";
import { ContextManager } from "./agent/context-manager.js";
import { backoffMs, classifyFailure, MAX_RETRIES } from "./agent/recovery.js";
import { answerOpenToolCalls, clearInterrupted, RunTracker, wasInterrupted } from "./agent/run-tracker.js";
import { isRestrictedUrl } from "./browser/cdp.js";
import { setCurrentBrowserSession } from "./browser/current.js";
import { dispatchToSandbox, setCdpMessageHandler } from "./browser/inject.js";
import {
	BrowserSession,
	isReleasedByUser,
	listSessions,
	sessionIdForTab,
	sessionOwningTab,
} from "./browser/session.js";
import "./components/OverflowMenu.js";
import type { MenuEntry } from "./components/OverflowMenu.js";
import { Toast } from "./components/Toast.js";
import { AboutTab } from "./dialogs/AboutTab.js";
import { ApiKeyOrOAuthDialog } from "./dialogs/ApiKeyOrOAuthDialog.js";
import { ApiKeysOAuthTab } from "./dialogs/ApiKeysOAuthTab.js";
import { BridgeTab } from "./dialogs/BridgeTab.js";
import { CostsTab } from "./dialogs/CostsTab.js";
import { CustomProvidersTab } from "./dialogs/CustomProvidersTab.js";
import { NotificationsTab } from "./dialogs/NotificationsTab.js";
import { PromptsTab } from "./dialogs/PromptsTab.js";
import { RecordSkillDialog } from "./dialogs/RecordSkillDialog.js";
import { SessionCostDialog } from "./dialogs/SessionCostDialog.js";
import { SitegeistSessionListDialog } from "./dialogs/SessionListDialog.js";
import { type SettingsSection, SettingsSheet } from "./dialogs/SettingsSheet.js";
import { SkillsTab } from "./dialogs/SkillsTab.js";
import { browserMessageTransformer } from "./messages/message-transformer.js";
import {
	createNavigationMessage,
	type NavigationMessage,
	registerNavigationRenderer,
} from "./messages/NavigationMessage.js";
import { registerUserMessageRenderer } from "./messages/UserMessageRenderer.js";
import { createWelcomeMessage, registerWelcomeRenderer } from "./messages/WelcomeMessage.js";
import { applyCachedModels, refreshDiscoveredModels } from "./models/registry.js";
import { notifyFromPanel, notifySettings, setNotifyEnabled } from "./notify/notifications.js";
import { borrowCliLogin, borrowCliLogins } from "./oauth/cli-login.js";
import { resolveApiKey } from "./oauth/index.js";
import { SYSTEM_PROMPT } from "./prompts/prompts.js";
import { Recorder } from "./recording/recorder.js";
import { SitegeistAppStorage } from "./storage/app-storage.js";
import { CoalescedTask } from "./storage/coalesced-task.js";
import { ANY_SITE } from "./storage/skill-match.js";
import { DebuggerTool } from "./tools/debugger.js";
import { createConsoleTool, createNetworkTool } from "./tools/devtools.js";
import { ExtractImageTool, registerExtractImageRenderer } from "./tools/extract-image.js";
import { createGifTool } from "./tools/gif.js";
import { AskUserWhichElementTool, skillTool } from "./tools/index.js";
import { NativeInputEventsRuntimeProvider } from "./tools/NativeInputEventsRuntimeProvider.js";
import { isToolNavigating, NavigateTool } from "./tools/navigate.js";
import { createReplTool } from "./tools/repl/repl.js";
import { BrowserJsRuntimeProvider, NavigateRuntimeProvider } from "./tools/repl/runtime-providers.js";
import { createUploadFileTool } from "./tools/upload-file.js";
import { syncCustomProviderCorsRules } from "./utils/custom-provider-cors.js";
import { downloadChatMarkdown } from "./utils/export-chat.js";
import * as port from "./utils/port.js";
import { watchSystemTheme } from "./utils/theme.js";
import "./utils/i18n-extension.js";
import "./utils/live-reload.js";
import { tutorials } from "./tutorials.js";

// Register custom message renderers
registerNavigationRenderer();
registerExtractImageRenderer();

// Listen for abort messages from REPL overlay
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
	console.log("[Sidepanel] Received message:", message, "from:", sender);
	if (message.type === "abort-repl") {
		console.log("[Sidepanel] Abort-repl message received, agent streaming:", agent?.state.isStreaming);
		if (agent?.state.isStreaming) {
			console.log("[Sidepanel] Aborting agent...");
			agent.abort();
			sendResponse({ success: true });
		} else {
			console.log("[Sidepanel] Agent not streaming, ignoring");
			sendResponse({ success: false, reason: "not-streaming" });
		}
		return true; // Keep channel open for async response
	}
});

// Messages from code injected through the debugger path (no userScripts API) arrive
// here instead of chrome.runtime.onMessage; route them exactly the same way.
setCdpMessageHandler(async (message) => {
	if (message.type === "abort-repl") {
		if (agent?.state.isStreaming) {
			agent.abort();
			return { success: true };
		}
		return { success: false, reason: "not-streaming" };
	}
	return dispatchToSandbox(message);
});

// ============================================================================
// STORAGE SETUP
// ============================================================================
const storage = new SitegeistAppStorage();
setAppStorage(storage);
watchSystemTheme();

// ============================================================================
// APP STATE
// ============================================================================
let currentSessionId: string | undefined;
let currentTitle = "";
let isEditingTitle = false;
let agent: Agent;
let chatPanel: ChatPanel;
let agentUnsubscribe: (() => void) | undefined;
let currentWindowId: number;

// Track which skills we've shown in full (skillName -> lastUpdated timestamp)
// Reset when a new session/agent is created
const shownSkills = new Map<string, string>();

// Track which messages we've already recorded costs for (avoid duplicates)
// Use Set with message object identity (not cleared on session switch - persists in memory)
const recordedCostMessages = new Set<AgentMessage>();

// Builds each turn's view of the chat; holds the summary of older turns once there is one.
let contextManager: ContextManager | undefined;

// Knows when a run in this panel is going, so the next panel can tell it died.
const runTracker = new RunTracker();
// This chat's last run ended with the panel; the user can resume it.
let interruptedRun = false;

// When the current run started, to leave quick answers out of notifications.
let runStartedAt = 0;
/** A run shorter than this was probably watched. */
const NOTIFY_MIN_RUN_MS = 15000;
// Offer notifications once the user has sat through a run long enough to want them.
let offerNotifications = false;
const NOTIFY_OFFERED_KEY = "notify_offered";

// Automatic recovery of a failed turn: attempts so far in this run, and the pending retry.
let retryAttempts = 0;
let overflowRecovered = false;
let retryTimer: ReturnType<typeof setTimeout> | undefined;

// Interaction recorder (record → save as site-scoped skill)
let recorder: Recorder | undefined;
let isRecording = false;

// Tells the service worker whether the agent is mid-run, so the panel is not hidden
// (and its document destroyed) on other tabs while work is in progress.
let lastPublishedBusy: boolean | undefined;
function publishBusyState(): void {
	const busy = agent?.state.isStreaming === true;
	if (busy === lastPublishedBusy) return;
	lastPublishedBusy = busy;
	// The value names the running task's home tab so the worker keeps exactly that panel up.
	chrome.storage.session
		.set({ [`sidepanel_busy_${currentWindowId}`]: busy ? (homeTabId ?? true) : false })
		.catch(() => undefined);
}
window.addEventListener("pagehide", () => {
	chrome.storage.session.remove(`sidepanel_busy_${currentWindowId}`).catch(() => undefined);
	void saveSession();
});

// The tabs this chat session owns (its own tab group; never the user's tabs)
let browserSession: BrowserSession | undefined;
// The tab this panel is bound to (Claude-style per-tab binding), from ?tabId= in the URL.
let homeTabId: number | undefined;

/** Browser-session id for an unsaved chat: stable per home tab so reopening the tab restores it. */
function unsavedSessionId(): string {
	return homeTabId !== undefined ? `tab-${homeTabId}` : `temp-${crypto.randomUUID()}`;
}

function sessionLabel(): string {
	const title = currentTitle.trim();
	if (!title) return "chat";
	return title.length > 28 ? `${title.slice(0, 27)}…` : title;
}

async function openBrowserSession(id: string): Promise<void> {
	browserSession = await BrowserSession.open(id, sessionLabel(), currentWindowId);
	setCurrentBrowserSession(browserSession);
	// Bind this panel's tab to the session (exclusive) and put it in the task's group so the
	// group exists from the start and the agent has a page to work with. The tab keeps showing
	// this task's panel; other tabs are unaffected.
	if (homeTabId !== undefined) {
		await browserSession.setHomeTab(homeTabId);
		// A tab an external agent is driving stays with that agent, and a tab the user took out
		// of the group stays theirs until they share it again; the panel only binds to either.
		const owner = await sessionOwningTab(homeTabId);
		const agentsTab = owner !== undefined && owner.id !== browserSession.id && owner.id.startsWith("bridge-");
		if (!agentsTab && !(await isReleasedByUser(homeTabId)))
			// Only start on the home tab; re-opening (e.g. the rename on first save) must not yank
			// the agent back from a tab it switched to.
			await browserSession.adopt(homeTabId, browserSession.currentTabId === undefined);
	}
	renderApp();
}

/** Move the window's active tab into the session (quietly on startup, with a toast on request). */
async function adoptActiveTab(notify: boolean): Promise<void> {
	if (!browserSession) return;
	const [tab] = await chrome.tabs.query({ active: true, windowId: currentWindowId });
	// Any tab can be the session's start, including a New Tab page the agent will navigate
	// away from; only the extension's own pages are excluded.
	if (!tab?.id || (tab.url ?? "").startsWith("chrome-extension://")) {
		if (notify) Toast.error("This page cannot be shared with the agent");
		return;
	}
	if (browserSession.tabIds.includes(tab.id)) return;
	await browserSession.adopt(tab.id, true);
	if (notify) Toast.success("Tab shared with the agent");
}

/** Unsaved browser sessions that never got a tab are noise; drop them at startup. */
async function pruneEmptyUnsavedSessions(): Promise<void> {
	for (const s of await listSessions()) {
		if ((s.id.startsWith("temp-") || s.id.startsWith("tab-")) && s.tabIds.length === 0) {
			const session = await BrowserSession.open(s.id, s.label, s.windowId);
			await session.close();
		}
	}
}

/** User gesture: hand the tab they are looking at to the agent. */
async function shareActiveTab(): Promise<void> {
	await adoptActiveTab(true);
	renderApp();
}

/**
 * Slash-command provider for the chat input: saved prompts, inserted as text, then skills
 * (recordings included), site-scoped first, as an @skill:<id> reference the agent retrieves.
 */
function buildSkillSlashProvider() {
	return async (query: string) => {
		let url: string | undefined;
		try {
			url = (await browserSession?.currentTab())?.url;
		} catch {
			/* ignore */
		}
		const all = await storage.skills.list();
		const onSite = url ? await storage.skills.list(url) : [];
		const onSiteNames = new Set(onSite.map((s) => s.name));
		const ordered = [...onSite, ...all.filter((s) => !onSiteNames.has(s.name))];
		const q = query.toLowerCase();
		const filtered = q
			? ordered.filter(
					(s) => s.name.toLowerCase().includes(q) || (s.shortDescription || "").toLowerCase().includes(q),
				)
			: ordered;
		const prompts = (await storage.prompts.list()).filter(
			(p) => !q || p.name.toLowerCase().includes(q) || p.text.toLowerCase().includes(q),
		);
		return [
			...prompts.map((p) => ({
				id: `prompt:${p.name}`,
				title: p.name,
				description: p.text,
				hint: "prompt",
				value: p.text,
			})),
			...filtered.slice(0, 20).map((s) => ({
				id: s.name,
				title: s.name,
				description: s.shortDescription,
				hint: onSiteNames.has(s.name)
					? "this site"
					: s.domainPatterns[0] === ANY_SITE
						? "any site"
						: s.domainPatterns[0],
				value: `@skill:${s.name}`,
			})),
		];
	};
}

async function toggleRecording() {
	if (isRecording && recorder) {
		const current = recorder;
		recorder = undefined;
		isRecording = false;
		renderApp();
		try {
			const result = await current.stop();
			RecordSkillDialog.open(result);
		} catch (err) {
			console.error("Failed to stop recording:", err);
			Toast.error("Failed to stop recording");
		}
		return;
	}

	const next = new Recorder();
	try {
		await next.start();
		recorder = next;
		isRecording = true;
		Toast.success("Recording — interact with the page, then click stop");
		renderApp();
	} catch (err) {
		console.error("Failed to start recording:", err);
		Toast.error("Cannot record this page");
	}
}

function downloadCurrentChat() {
	if (!agent) return;
	const messages = agent.state.messages.filter((m) => m.role !== "welcome");
	if (messages.length === 0) {
		Toast.error("Nothing to export yet");
		return;
	}
	downloadChatMarkdown(messages, currentTitle || "Sitegeist chat", agent.state.model);
}

const DEFAULT_MODELS: Record<string, string> = {
	"amazon-bedrock": "us.anthropic.claude-opus-4-6-v1",
	anthropic: "claude-sonnet-4-6",
	"azure-openai-responses": "gpt-5.2",
	cerebras: "zai-glm-4.6",
	"github-copilot": "gpt-4o",
	google: "gemini-2.5-flash",
	"google-antigravity": "gemini-3.1-pro-high",
	"google-gemini-cli": "gemini-2.5-pro",
	"google-vertex": "gemini-3-pro-preview",
	groq: "openai/gpt-oss-20b",
	huggingface: "moonshotai/Kimi-K2.5",
	"kimi-coding": "kimi-k2-thinking",
	minimax: "MiniMax-M2.1",
	"minimax-cn": "MiniMax-M2.1",
	mistral: "devstral-medium-latest",
	openai: "gpt-4o-mini",
	opencode: "claude-opus-4-6",
	"opencode-go": "kimi-k2.5",
	openrouter: "openai/gpt-5.1-codex",
	"vercel-ai-gateway": "anthropic/claude-opus-4-6",
	xai: "grok-4-fast-non-reasoning",
	zai: "glm-4.6",
};

/**
 * Default model for the providers the user has keys for: a listed default first, else the
 * first model of the first provider that has any (discovered lists come in the provider's
 * own order, so that is the provider's default).
 */
function defaultModelFor(providers: string[]): Model<any> | undefined {
	for (const provider of providers) {
		const modelId = DEFAULT_MODELS[provider];
		const model = modelId ? getModel(provider as any, modelId) : undefined;
		if (model) return model;
	}
	for (const provider of providers) {
		const models = getModels(provider as any);
		if (models.length > 0) return models[0];
	}
	return undefined;
}

/**
 * A saved model its provider no longer lists (retired, or hidden from the provider's picker)
 * gives way to that provider's default. Only a discovered list is trusted for this; static
 * tables and custom providers keep the saved model.
 */
async function stillOffered(saved: Model<any>): Promise<Model<any>> {
	if (!(await applyCachedModels(storage, saved.provider))) return saved;
	if (getModels(saved.provider as any).some((m) => m.id === saved.id)) return saved;
	return defaultModelFor([saved.provider]) ?? saved;
}

async function selectDefaultModelForAvailableProvider() {
	const providers = await getProvidersWithKeys();
	if (providers.length === 0 || !agent) return;

	const model = defaultModelFor(providers);
	if (model) {
		agent.setModel(model);
		await storage.settings.set("lastUsedModel", model);
		renderApp();
		return;
	}

	// Fall back to the first model of a custom provider (not in the built-in registry)
	const customProviders = await storage.customProviders.getAll();
	for (const customProvider of customProviders) {
		const model = customProvider.models?.[0];
		if (model) {
			agent.setModel(model);
			await storage.settings.set("lastUsedModel", model);
			renderApp();
			return;
		}
	}
}

async function getProvidersWithKeys(): Promise<string[]> {
	const providers = await storage.providerKeys.list();
	const result: string[] = [];
	for (const provider of providers) {
		const key = await storage.providerKeys.get(provider);
		if (key) result.push(provider);
	}
	return result;
}

async function hasAnyApiKey(): Promise<boolean> {
	const providers = await storage.providerKeys.list();
	return providers.length > 0;
}

function settingsSections(): SettingsSection[] {
	return [
		{ label: "Providers", hint: "Subscriptions and API keys", tab: new ApiKeysOAuthTab() },
		{ label: "Custom providers", hint: "OpenAI- or Anthropic-compatible endpoints", tab: new CustomProvidersTab() },
		{ label: "Skills", hint: "Site scripts the agent can reuse", tab: new SkillsTab() },
		{ label: "Prompts", hint: "Reusable prompts for the / menu", tab: new PromptsTab() },
		{ label: "Bridge", hint: "Let coding agents use this browser", tab: new BridgeTab() },
		{ label: "Notifications", hint: "When a task finishes or needs you", tab: new NotificationsTab() },
		{ label: "Costs", hint: "Spend by day and model", tab: new CostsTab() },
		{ label: "Proxy", hint: "CORS proxy for providers that need one", tab: new ProxyTab() },
		{ label: "About", hint: "Version and links", tab: new AboutTab() },
	];
}

/** Settings sheet; resolves when it closes. `section` opens straight into one section. */
function openSettings(section?: string): Promise<void> {
	return new Promise((resolve) => {
		SettingsSheet.open(settingsSections(), { section, onClose: resolve });
	});
}

function openApiKeysDialog(): Promise<void> {
	return openSettings("Providers");
}

// Export getter for message transformer
export function getShownSkills(): Map<string, string> {
	return shownSkills;
}

// ============================================================================
// HELPERS
// ============================================================================
const generateTitle = (messages: AgentMessage[]): string => {
	const firstUserMsg = messages.find((m) => m.role === "user");
	if (firstUserMsg?.role !== "user") return "";

	let text = "";
	const content = firstUserMsg.content;

	if (typeof content === "string") {
		text = content;
	} else {
		const textBlocks = content.filter((c) => c.type === "text");
		text = textBlocks.map((c) => c.text || "").join(" ");
	}

	text = text.trim();
	if (!text) return "";

	const sentenceEnd = text.search(/[.!?]/);
	if (sentenceEnd > 0 && sentenceEnd <= 50) {
		return text.substring(0, sentenceEnd + 1);
	}
	return text.length <= 50 ? text : `${text.substring(0, 47)}...`;
};

const shouldSaveSession = (messages: AgentMessage[]): boolean => {
	const hasUserMsg = messages.some((m: AgentMessage) => m.role === "user");
	const hasAssistantMsg = messages.some((m: AgentMessage) => m.role === "assistant");
	return hasUserMsg && hasAssistantMsg;
};

const writeSession = async () => {
	if (!storage.sessions || !currentSessionId || !agent || !currentTitle) return;

	const state = agent.state;
	if (!shouldSaveSession(state.messages)) return;

	try {
		// Calculate cumulative usage from all assistant messages
		const usage = {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};

		for (const msg of state.messages) {
			if (msg.role === "assistant") {
				usage.input += msg.usage.input;
				usage.output += msg.usage.output;
				usage.cacheRead += msg.usage.cacheRead;
				usage.cacheWrite += msg.usage.cacheWrite;
				usage.totalTokens += msg.usage.input + msg.usage.output + msg.usage.cacheRead + msg.usage.cacheWrite;
				if (msg.usage.cost) {
					usage.cost.input += msg.usage.cost.input;
					usage.cost.output += msg.usage.cost.output;
					usage.cost.cacheRead += msg.usage.cost.cacheRead;
					usage.cost.cacheWrite += msg.usage.cost.cacheWrite;
					usage.cost.total += msg.usage.cost.total;
				}
			}
		}

		// Generate preview text (first 2KB of user + assistant text)
		let preview = "";
		for (const msg of state.messages) {
			if (preview.length >= 2048) break;
			if (msg.role === "user") {
				const text =
					typeof msg.content === "string"
						? msg.content
						: msg.content
								.filter((c) => c.type === "text")
								.map((c) => c.text)
								.join("\n") || "";
				preview += `${text}\n`;
			} else if (msg.role === "assistant") {
				const text = msg.content
					.filter((c) => c.type === "text" || c.type === "thinking")
					.map((c) => (c.type === "text" ? c.text : c.thinking))
					.join("\n");
				preview += `${text}\n`;
			}
		}
		preview = preview.substring(0, 2048);

		// Preserve createdAt if session already exists
		const existingMetadata = await storage.sessions.getMetadata(currentSessionId);
		const createdAt = existingMetadata?.createdAt || new Date().toISOString();

		const metadata = {
			id: currentSessionId,
			title: currentTitle,
			createdAt,
			lastModified: new Date().toISOString(),
			messageCount: state.messages.length,
			usage,
			modelId: state.model.id,
			thinkingLevel: state.thinkingLevel,
			preview,
		};

		await storage.sessions.saveSession(currentSessionId, state, metadata, currentTitle);
	} catch (err) {
		console.error("Failed to save session:", err);
	}
};

// A save structured-clones the whole chat, screenshots included. Writes never overlap, so a
// slow one cannot be overtaken by an older snapshot.
const sessionSaver = new CoalescedTask(writeSession);
const saveSession = () => sessionSaver.request();

const updateUrl = (sessionId: string) => {
	const url = new URL(window.location.href);
	if (homeTabId !== undefined) url.searchParams.set("tabId", String(homeTabId));
	url.searchParams.set("session", sessionId);
	window.history.replaceState({}, "", url);
};

/**
 * Self-hosted OpenAI-compatible endpoints (custom providers: Local Studio, vLLM, SGLang,
 * llama.cpp) get no max_tokens: the dialog's per-model default was 8192, which cut
 * thinking models off mid-answer. The server then applies the model's full context.
 */
function uncappedStreamFn<F extends (model: Model<any>, ...rest: any[]) => any>(inner: F): F {
	return (async (model: Model<any>, ...rest: any[]) => {
		if (model.api === "openai-completions") {
			const custom = await storage.customProviders.getAll().catch(() => []);
			if (custom.some((p) => p.name === model.provider)) {
				model = { ...model, compat: { ...(model.compat ?? {}), omitMaxTokens: true } };
			}
		}
		return inner(model, ...rest);
	}) as F;
}

const compactionKey = (sessionId: string) => `compaction.${sessionId}`;

function saveCompaction(compaction: Compaction | undefined): void {
	if (!compaction || !currentSessionId) return;
	storage.settings.set(compactionKey(currentSessionId), compaction).catch((err) => {
		console.error("Failed to save the chat summary:", err);
	});
}

/** Stop a retry that is waiting; the user took over. */
function cancelRetry(): void {
	if (retryTimer) clearTimeout(retryTimer);
	retryTimer = undefined;
}

/**
 * A failed turn that can pass on its own (rate limit, overloaded server, dropped connection) is
 * retried with backoff, and a chat that outgrew the context window is summarized and continued.
 * The failed message leaves the chat, so the model never sees it and `continue` is valid.
 */
async function recoverFailedTurn(): Promise<boolean> {
	const last = agent.state.messages.at(-1);
	if (last?.role !== "assistant") return false;
	const failure = classifyFailure(last, agent.state.model.contextWindow);
	if (!failure) return false;

	const withoutFailed = agent.state.messages.slice(0, -1);
	if (failure === "overflow") {
		if (overflowRecovered) return false;
		overflowRecovered = true;
		Toast.show("Summarizing older messages to stay within the context window");
		const compacted = await contextManager?.compact(withoutFailed).catch((err) => {
			console.warn("[Context] summary failed:", err);
			return false;
		});
		if (!compacted) return false;
		agent.replaceMessages(withoutFailed);
		await agent.continue();
		return true;
	}

	if (retryAttempts >= MAX_RETRIES) return false;
	retryAttempts++;
	const delay = backoffMs(retryAttempts, last.errorMessage);
	Toast.show(`Provider error, retrying in ${Math.round(delay / 1000)} s (${retryAttempts} of ${MAX_RETRIES})`);
	retryTimer = setTimeout(() => {
		retryTimer = undefined;
		agent.replaceMessages(withoutFailed);
		agent.continue().catch((err) => console.error("Retry failed:", err));
	}, delay);
	return true;
}

/** The run is over for good: tell a user who is elsewhere, and offer notifications if they have none. */
async function announceRunEnd(): Promise<void> {
	if (Date.now() - runStartedAt < NOTIFY_MIN_RUN_MS) return;
	const last = agent.state.messages.at(-1);
	if (last?.role !== "assistant" || last.stopReason === "aborted") return;
	const failed = last.stopReason === "error";
	const reply = last.content
		.filter((c): c is TextContent => c.type === "text")
		.map((c) => c.text)
		.join(" ")
		.trim();
	notifyFromPanel({
		kind: failed ? "failed" : "done",
		title: currentTitle || (failed ? "Task failed" : "Task finished"),
		message: failed ? (last.errorMessage ?? "The task stopped with an error.") : reply || "Finished.",
		tabId: browserSession?.currentTabId,
	});
	const { granted } = await notifySettings();
	if (granted) return;
	const offered = await chrome.storage.local.get(NOTIFY_OFFERED_KEY);
	if (offered[NOTIFY_OFFERED_KEY]) return;
	offerNotifications = true;
	renderApp();
}

function dismissNotificationOffer(): void {
	offerNotifications = false;
	chrome.storage.local.set({ [NOTIFY_OFFERED_KEY]: true }).catch(() => undefined);
	renderApp();
}

async function acceptNotificationOffer(): Promise<void> {
	// First await of the click: the request needs its user gesture.
	const granted = await chrome.permissions.request({ permissions: ["notifications"] });
	if (granted) await setNotifyEnabled(true);
	dismissNotificationOffer();
}

function dismissInterruptedRun(): void {
	interruptedRun = false;
	if (currentSessionId) clearInterrupted(currentSessionId).catch(() => undefined);
	renderApp();
}

/** Pick up a run that ended with the panel, from the last thing that was saved. */
async function resumeInterruptedRun(): Promise<void> {
	dismissInterruptedRun();
	const messages = answerOpenToolCalls(agent.state.messages);
	agent.replaceMessages(messages);
	chatPanel.agentInterface?.requestUpdate();
	if (messages.at(-1)?.role === "assistant") return;
	retryAttempts = 0;
	overflowRecovered = false;
	await agent.continue();
}

let rememberedModel: string | undefined;

/** Keep the model for the next new chat; written only when it changed. */
function rememberModel(model: Model<any>): void {
	const key = `${model.provider}/${model.id}`;
	if (key === rememberedModel) return;
	rememberedModel = key;
	storage.settings.set("lastUsedModel", model).catch((err) => console.error("Failed to save lastUsedModel:", err));
}

const createAgent = async (initialState?: Partial<AgentState>, shouldSave = true, compaction?: Compaction) => {
	if (agentUnsubscribe) {
		agentUnsubscribe();
	}
	cancelRetry();

	// Mark all loaded messages as already recorded (by object identity)
	for (const msg of initialState?.messages || []) {
		if (msg.role === "assistant" && msg.usage?.cost?.total > 0) {
			recordedCostMessages.add(msg);
		}
	}

	// Reset skill tracking for new session
	// When loading an old session, we intentionally don't reconstruct shownSkills
	// This ensures that new navigations in the continued session show the LATEST
	// version of skills, even if they were updated since the session was created
	shownSkills.clear();

	// Every chat owns a browser session; unsaved chats use a temporary id until first save
	await openBrowserSession(currentSessionId ?? unsavedSessionId());

	// Load debugger mode setting
	const stored = await chrome.storage.local.get("debuggerMode");
	const debuggerModeEnabled = stored.debuggerMode || false;

	// Load CORS proxy settings for extract_document tool
	const corsProxyEnabled = await storage.settings.get<boolean>("proxy.enabled");
	const corsProxyUrl = await storage.settings.get<string>("proxy.url");

	// Determine default model: saved > default for a provider with key > gemini flash fallback
	let defaultModel: Model<any> | undefined;
	if (!initialState?.model) {
		const savedModel = await storage.settings.get<Model<any>>("lastUsedModel");
		if (savedModel) {
			defaultModel = await stillOffered(savedModel);
		} else {
			// A default model for a provider the user already has a key for
			defaultModel = defaultModelFor(await getProvidersWithKeys());
		}
	}
	// Final fallback
	if (!defaultModel && !initialState?.model) {
		defaultModel = getModel("anthropic", "claude-sonnet-4-6");
	}

	const streamFn = uncappedStreamFn(
		createStreamFn(async () => {
			const enabled = await storage.settings.get<boolean>("proxy.enabled");
			if (!enabled) return undefined;
			return (await storage.settings.get<string>("proxy.url")) || undefined;
		}),
	);
	const getApiKey = async (provider: string) => {
		const stored = await storage.providerKeys.get(provider);
		if (!stored) return undefined;
		const proxyEnabled = await storage.settings.get<boolean>("proxy.enabled");
		const proxyUrl = proxyEnabled ? (await storage.settings.get<string>("proxy.url")) || undefined : undefined;
		return resolveApiKey(stored, provider, storage.providerKeys, proxyUrl);
	};

	contextManager = new ContextManager(
		{
			model: () => agent.state.model,
			summarize: async (prompt, signal) => {
				const model = agent.state.model;
				const stream = await streamFn(
					model,
					{
						systemPrompt: SUMMARY_SYSTEM_PROMPT,
						messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
					},
					{ apiKey: await getApiKey(model.provider), signal, maxTokens: 4000 },
				);
				const reply = await stream.result();
				if (reply.stopReason === "error") throw new Error(reply.errorMessage ?? "Summary failed");
				return reply.content
					.filter((c): c is TextContent => c.type === "text")
					.map((c) => c.text)
					.join("\n");
			},
			onCompaction: (next) => {
				saveCompaction(next);
				Toast.show("Older messages summarized to stay within the context window");
			},
		},
		compaction,
	);

	agent = new Agent({
		initialState: initialState || {
			systemPrompt: SYSTEM_PROMPT,
			model: defaultModel,
			thinkingLevel: "medium",
			messages: [],
			tools: [],
		},
		convertToLlm: browserMessageTransformer,
		transformContext: (messages, signal) => contextManager?.prepare(messages, signal) ?? Promise.resolve(messages),
		toolExecution: "sequential",
		streamFn,
		getApiKey,
	});

	if (shouldSave) {
		agentUnsubscribe = agent.subscribe((event: AgentEvent) => {
			const messages = agent.state.messages;
			publishBusyState();
			if (event.type === "agent_start" && !retryTimer) runStartedAt = Date.now();

			// Hot path: a delta only moves agent.state.streamMessage, which AgentInterface renders
			// itself. Doing anything more per token cost 98% of the main thread on long chats.
			if (event.type === "message_update" || event.type === "tool_execution_update") return;

			rememberModel(agent.state.model);
			if (currentSessionId && agent.state.isStreaming) runTracker.start(currentSessionId);

			if (
				event.type === "message_end" &&
				event.message.role === "assistant" &&
				event.message.usage?.cost?.total > 0
			) {
				if (!recordedCostMessages.has(event.message)) {
					recordedCostMessages.add(event.message);
					storage.costs
						.recordCost(agent.state.model.provider, agent.state.model.id, event.message.usage.cost.total)
						.catch((err) => console.error("Failed to record cost:", err));
				}
			}

			if (!currentTitle && shouldSaveSession(messages)) {
				currentTitle = generateTitle(messages);
				browserSession?.setLabel(sessionLabel()).catch(() => {});
			}

			if (!currentSessionId && shouldSaveSession(messages)) {
				currentSessionId = crypto.randomUUID();
				// Rename the unsaved browser session (id "tab-<homeTab>") to the saved id, keeping
				// its home-tab binding and tab group, so the panel stays bound to the same tab.
				const unsavedId = unsavedSessionId();
				const savedId = currentSessionId;
				BrowserSession.rename(unsavedId, savedId)
					.then(() => openBrowserSession(savedId))
					.catch((err) => console.error("Failed to rename browser session:", err));
				updateUrl(savedId);
			}

			if (currentSessionId && (event.type === "message_end" || event.type === "agent_end")) {
				saveSession();
			}

			if (event.type === "agent_end") {
				runTracker.stop();
				recoverFailedTurn()
					.catch((err) => {
						console.error("Recovery failed:", err);
						return false;
					})
					.then((recovering) => (recovering ? undefined : announceRunEnd()))
					.catch((err) => console.error("Announcing the run failed:", err));
			}

			renderApp();
		});
	}

	await chatPanel.setAgent(agent, {
		sandboxUrlProvider: () => {
			return chrome.runtime.getURL("sandbox.html");
		},
		onApiKeyRequired: async (provider: string) => {
			if (await borrowCliLogin(storage.providerKeys, provider)) return true;
			return await ApiKeyOrOAuthDialog.prompt(provider);
		},
		onModelSelect: async () => {
			const providers = await getProvidersWithKeys();
			if (providers.length === 0) {
				openApiKeysDialog();
				return;
			}
			// Cached lists are already registered; give stale providers a moment to refresh.
			await refreshDiscoveredModels(storage, { wait: true, timeoutMs: 4000 }).catch(() => {});
			ModelSelector.open(
				agent.state.model,
				(model) => {
					agent.setModel(model);
					chatPanel.agentInterface?.requestUpdate();
					renderApp();
				},
				providers,
				{
					level: agent.state.thinkingLevel,
					onChange: (level) => {
						agent.setThinkingLevel(level);
						chatPanel.agentInterface?.requestUpdate();
						saveSession();
						renderApp();
					},
				},
			);
		},
		onBeforeSend: async () => {
			if (!agent) return;
			browserSession?.userAskedAgain();
			cancelRetry();
			retryAttempts = 0;
			overflowRecovered = false;
			if (interruptedRun) dismissInterruptedRun();

			// The session's current tab (nothing if the session has no tab yet)
			const tab = await browserSession?.currentTab();
			if (!tab?.url || isRestrictedUrl(tab.url)) return;

			// Find most recent navigation (either nav message or nav tool result)
			let lastUrl: string | undefined;
			for (let i = agent.state.messages.length - 1; i >= 0; i--) {
				const msg = agent.state.messages[i];
				if (msg.role === "navigation") {
					lastUrl = (msg as NavigationMessage).url;
					break;
				}
				if (msg.role === "toolResult" && (msg as any).toolName === "navigate") {
					lastUrl = (msg as any).details?.finalUrl;
					break;
				}
			}

			// Only add if URL changed
			if (!lastUrl || lastUrl !== tab.url) {
				const navMessage = await createNavigationMessage(tab.url, tab.title || "Untitled", tab.favIconUrl, tab.id);
				agent.appendMessage(navMessage);
			}
		},
		onCostClick: () => {
			if (!agent) return;
			SessionCostDialog.open(agent.state.messages);
		},
		toolsFactory: (_agent, _agentInterface, artifactsPanel, runtimeProvidersFactory) => {
			const navigateTool = new NavigateTool();
			const selectElementTool = new AskUserWhichElementTool();

			// Create extract_document tool with CORS proxy from settings (loaded above)
			const extractDocumentTool = createExtractDocumentTool();
			if (corsProxyEnabled && corsProxyUrl) {
				extractDocumentTool.corsProxyUrl = `${corsProxyUrl}/?url=`;
			}

			const replTool = createReplTool();
			replTool.sandboxUrlProvider = () => chrome.runtime.getURL("sandbox.html");

			// Extend base providers with browser orchestration capabilities
			replTool.runtimeProvidersFactory = () => {
				// Providers that should be available in page context via browserjs()
				const pageProviders = [
					...runtimeProvidersFactory(), // attachments + artifacts from ChatPanel
					new NativeInputEventsRuntimeProvider(), // trusted browser events
				];

				return [
					...pageProviders, // Make them available in REPL context too
					new BrowserJsRuntimeProvider(pageProviders), // Pass to page context
					new NavigateRuntimeProvider(navigateTool),
				];
			};

			const extractImageTool = new ExtractImageTool();

			const tools: AgentTool<any, any>[] = [
				navigateTool,
				selectElementTool,
				replTool,
				skillTool,
				extractDocumentTool,
				extractImageTool,
				createUploadFileTool(
					() => agent.state.messages,
					() => artifactsPanel,
				),
				createGifTool(),
				createConsoleTool(),
				createNetworkTool(),
			];

			// Conditionally add debugger tool if enabled
			if (debuggerModeEnabled) {
				const debuggerTool = new DebuggerTool();
				tools.push(debuggerTool);
			}

			return tools;
		},
	});

	// Register custom message renderers after agentInterface is available
	if (chatPanel.agentInterface) {
		registerWelcomeRenderer(agent, chatPanel.agentInterface, {
			hasProvider: hasAnyApiKey,
			connect: async () => {
				await openSettings("Providers");
				await refreshDiscoveredModels(storage, { wait: true }).catch(() => {});
				await selectDefaultModelForAvailableProvider();
				renderApp();
			},
		});

		// Thinking level now lives inside the model picker, not as a separate
		// dropdown in the input toolbar.
		chatPanel.agentInterface.enableThinkingSelector = false;
		// "/" in the chat input lists skills (recordings included) for the site.
		chatPanel.agentInterface.slashCommandProvider = buildSkillSlashProvider();
		// ArrowUp in an empty composer recalls the last prompt for editing or resending.
		chatPanel.agentInterface.historyProvider = () => {
			for (let i = agent.state.messages.length - 1; i >= 0; i--) {
				const m = agent.state.messages[i];
				if (m.role !== "user") continue;
				const text =
					typeof m.content === "string"
						? m.content
						: m.content
								.filter((c) => c.type === "text")
								.map((c) => c.text)
								.join("\n");
				if (text.trim()) return text;
			}
			return undefined;
		};
		chatPanel.agentInterface.requestUpdate();

		// Only disable auto-scroll for new sessions with welcome message
		// Check if this is a fresh session (only has welcome message, no user messages)
		const hasUserMessage = agent.state.messages.some((m) => m.role === "user");
		if (!hasUserMessage) {
			chatPanel.agentInterface.setAutoScroll(false);

			// Re-enable auto-scroll on first user message
			let unsubscribe: (() => void) | undefined;
			unsubscribe = agent.subscribe(() => {
				const hasUserMsg = agent.state.messages.some((m) => m.role === "user");
				if (hasUserMsg && unsubscribe) {
					chatPanel.agentInterface?.setAutoScroll(true);
					unsubscribe();
				}
			});
		}
	}
};

const loadSession = (sessionId: string) => {
	const url = new URL(window.location.href);
	url.search = "";
	if (homeTabId !== undefined) url.searchParams.set("tabId", String(homeTabId));
	url.searchParams.set("session", sessionId);
	window.location.href = url.toString();
};

const newSession = () => {
	// A new task on the same tab: keep the tabId, force a fresh session bound to it.
	const url = new URL(window.location.href);
	url.search = "";
	if (homeTabId !== undefined) url.searchParams.set("tabId", String(homeTabId));
	url.searchParams.set("new", "true");
	window.location.href = url.toString();
};

// ============================================================================
// RENDER
// ============================================================================
function noticeBar(text: string, ...actions: TemplateResult[]): TemplateResult {
	return html`<div
		class="flex items-center gap-2 px-3 py-2 border-b border-border text-sm text-foreground shrink-0"
		role="status"
	>
		<span class="flex-1 min-w-0">${text}</span>
		${actions}
	</div>`;
}

const renderApp = () => {
	const appHtml = html`
		<div class="w-full h-full flex flex-col bg-background text-foreground overflow-hidden">
			<!-- Header: sessions, title, new chat, and everything else behind the overflow menu -->
			<div class="flex items-center gap-1 h-11 px-1.5 border-b border-border shrink-0">
				${Button({
					variant: "ghost",
					size: "icon",
					children: icon(History, "sm"),
					onClick: () => {
						SitegeistSessionListDialog.open(
							(sessionId: string) => {
								loadSession(sessionId);
							},
							(deletedSessionId: string) => {
								// Only reload if the current session was deleted
								if (deletedSessionId === currentSessionId) {
									newSession();
								}
							},
						);
					},
					title: "Sessions",
				})}
				<div class="flex-1 min-w-0 flex items-center">
					${
						currentTitle
							? isEditingTitle
								? html`<div class="flex items-center gap-2">
									${Input({
										type: "text",
										value: currentTitle,
										className: "text-sm w-full",
										/*
										TODO need to add this in Input in mini-lit
										onBlur: async (e: Event) => {
											const newTitle = (e.target as HTMLInputElement).value.trim();
											if (newTitle && newTitle !== currentTitle && storage.sessions && currentSessionId) {
												await storage.sessions.updateTitle(currentSessionId, newTitle);
												currentTitle = newTitle;
											}
											isEditingTitle = false;
											renderApp();
										},*/
										onKeyDown: async (e: KeyboardEvent) => {
											if (e.key === "Enter") {
												const newTitle = (e.target as HTMLInputElement).value.trim();
												if (newTitle && newTitle !== currentTitle && storage.sessions && currentSessionId) {
													await storage.sessions.updateTitle(currentSessionId, newTitle);
													currentTitle = newTitle;
												}
												isEditingTitle = false;
												renderApp();
											} else if (e.key === "Escape") {
												isEditingTitle = false;
												renderApp();
											}
										},
									})}
								</div>`
								: html`<button
									class="px-2 py-1 text-sm font-medium text-foreground hover:bg-accent rounded-md truncate max-w-full"
									@click=${() => {
										isEditingTitle = true;
										renderApp();
										requestAnimationFrame(() => {
											const input = document.body.querySelector('input[type="text"]') as HTMLInputElement;
											if (input) {
												input.focus();
												input.select();
											}
										});
									}}
									title="Click to edit title"
								>
									${currentTitle}
								</button>`
							: html`<span class="px-2 text-sm text-muted-foreground">New chat</span>`
					}
				</div>
				${
					isRecording
						? html`<button
								class="flex items-center gap-1.5 h-7 px-2 rounded-md text-xs font-medium text-destructive hover:bg-accent"
								title="Stop recording and save as skill"
								@click=${toggleRecording}
							>
								<span class="size-1.5 rounded-full bg-destructive animate-pulse"></span>
								Stop
							</button>`
						: ""
				}
				${Button({
					variant: "ghost",
					size: "icon",
					children: icon(Plus, "sm"),
					onClick: newSession,
					title: "New chat",
				})}
				<overflow-menu
					.entries=${
						[
							{ label: "Share this tab", icon: Link, onSelect: shareActiveTab },
							{
								label: isRecording ? "Stop recording" : "Record a skill",
								icon: isRecording ? Square : Circle,
								onSelect: toggleRecording,
							},
							{ label: "Download chat", icon: Download, onSelect: downloadCurrentChat },
							"separator",
							"theme",
							"separator",
							{ label: "Settings", icon: Settings, onSelect: () => void openSettings() },
						] satisfies MenuEntry[]
					}
				></overflow-menu>
			</div>

			${
				interruptedRun
					? noticeBar(
							"This task stopped when the panel closed.",
							Button({
								variant: "default",
								size: "sm",
								children: "Resume",
								onClick: () => void resumeInterruptedRun(),
							}),
							Button({ variant: "ghost", size: "sm", children: "Dismiss", onClick: dismissInterruptedRun }),
						)
					: ""
			}
			${
				offerNotifications
					? noticeBar(
							"Get a notification when tasks finish?",
							Button({
								variant: "default",
								size: "sm",
								children: "Turn on",
								onClick: () => void acceptNotificationOffer(),
							}),
							Button({ variant: "ghost", size: "sm", children: "Not now", onClick: dismissNotificationOffer }),
						)
					: ""
			}

			<!-- Chat Panel -->
			${chatPanel}
		</div>
	`;

	render(appHtml, document.body);
};

// ============================================================================
// TAB NAVIGATION TRACKING
// ============================================================================

// The agent only hears about URL changes on its own current tab (a page redirecting
// or the user navigating a shared tab). The user's other tabs are never observed.
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
	if (
		changeInfo.url &&
		tab.url &&
		browserSession?.currentTabId === tabId &&
		agent?.state.isStreaming &&
		!isRestrictedUrl(tab.url) &&
		!isToolNavigating()
	) {
		const navMessage = await createNavigationMessage(tab.url, tab.title || "Untitled", tab.favIconUrl, tab.id);
		agent.steer(navMessage);
		console.log("Queued navigation message for", tab.url);
	}
});

// ============================================================================
// KEYBOARD SHORTCUTS
// ============================================================================
window.addEventListener(
	"keydown",
	(e) => {
		// Escape key to abort streaming - works globally in sidepanel
		// Use capturing phase to intercept before MessageEditor handles it
		if (e.key === "Escape" && retryTimer) cancelRetry();
		if (e.key === "Escape" && agent?.state.isStreaming && !document.querySelector("overflow-menu[open]")) {
			e.preventDefault();
			e.stopPropagation();
			agent.abort();
		}

		// Cmd+U (Mac) or Ctrl+U (Windows/Linux) to open debug page
		if ((e.metaKey || e.ctrlKey) && e.key === "u") {
			e.preventDefault();
			window.location.href = "./debug.html";
		}

		// Cmd+Shift+K (Mac) or Ctrl+Shift+K (Windows/Linux) to show session costs
		if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "k") {
			e.preventDefault();
			if (agent?.state.messages && agent.state.messages.length > 0) {
				SessionCostDialog.open(agent.state.messages);
			}
		}
	},
	true,
); // Use capture phase to intercept Escape before it reaches MessageEditor

// ============================================================================
// TEST STEPS FROM DEBUGGER.TS
// ============================================================================
async function testSteps(): Promise<boolean> {
	const urlParams = new URLSearchParams(window.location.search);
	const testStepsParam = urlParams.get("teststeps");
	const testProvider = urlParams.get("provider");
	const testModel = urlParams.get("model");

	if (!testStepsParam) return false;

	// Handle test prompts - create temporary session without saving
	try {
		const testSteps = JSON.parse(decodeURIComponent(testStepsParam)) as string[];

		// Set model if specified
		let initialState: Partial<AgentState> | undefined;
		if (testProvider && testModel) {
			const model = getModel(testProvider as any, testModel);
			if (model) {
				initialState = {
					systemPrompt: SYSTEM_PROMPT,
					model,
				};
			}
		}

		await createAgent(initialState, false);
		renderApp();

		// Wait for UI to render
		await new Promise((resolve) => requestAnimationFrame(resolve));

		// Submit prompts sequentially
		for (let i = 0; i < testSteps.length; i++) {
			const step = testSteps[i];
			if (!chatPanel?.agentInterface) break;

			// Send the prompt
			await chatPanel.agentInterface.sendMessage(step);

			// Wait for agent to finish (not streaming anymore)
			if (i < testSteps.length - 1) {
				// Wait for response to complete before sending next step
				await new Promise<void>((resolve) => {
					const checkComplete = () => {
						if (!chatPanel.agent?.state.isStreaming) {
							resolve();
						} else {
							setTimeout(checkComplete, 100);
						}
					};
					checkComplete();
				});
			}
		}
		return true;
	} catch (err) {
		console.error("Failed to run test steps:", err);
		return false;
	}
}

// ============================================================================
// INIT
// ============================================================================
async function initApp() {
	// Show loading
	render(
		html`
			<div class="w-full h-full flex items-center justify-center bg-background text-foreground">
				<div class="text-muted-foreground">Loading...</div>
			</div>
		`,
		document.body,
	);

	// Load showJsonMode setting
	const stored = await chrome.storage.local.get("showJsonMode");
	const showJsonModeEnabled = (stored.showJsonMode as boolean) || false;
	setShowJsonMode(showJsonModeEnabled);

	// Reconcile CORS rules for any configured custom providers (dynamic DNR rules
	// don't ship in the static manifest, so make sure they exist after a reload).
	syncCustomProviderCorsRules().catch((err) => console.error("Failed to sync custom provider CORS rules:", err));

	// Get current window ID for filtering tab events
	const currentWindow = await chrome.windows.getCurrent();
	if (!currentWindow.id) {
		throw new Error("Failed to get current window ID");
	}
	currentWindowId = currentWindow.id;

	// The tab this panel is bound to, from ?tabId= in the URL (background sets it per tab).
	const homeTabParam = new URLSearchParams(window.location.search).get("tabId");
	homeTabId = homeTabParam ? Number(homeTabParam) : undefined;

	// Initialize port communication system (lifecycle only; background tracks open panels)
	port.initialize(currentWindowId);

	pruneEmptyUnsavedSessions().catch(() => {});

	// Claude Code's and Codex's logins stand in for providers with no key, so a fresh install
	// works without connecting anything. Capped: an old CLI host never answers the lookup.
	await Promise.race([
		borrowCliLogins(storage.providerKeys).catch((err) => console.warn("Borrowing CLI logins failed:", err)),
		new Promise((resolve) => setTimeout(resolve, 5000)),
	]);

	// Register cached provider model lists now; refresh stale ones in the background.
	refreshDiscoveredModels(storage).catch((err) => console.warn("Model discovery failed:", err));

	// TODO reenable Request persistent storage
	// if (storage.sessions) {
	// 	await PersistentStorageDialog.request();
	// }

	// In-page scripts use the userScripts API when the browser exposes it and fall back
	// to an isolated content-script world otherwise, so no permission prompt is needed.

	// Initialize default skills
	const { initializeDefaultSkills } = await import("./tools/skill.js");
	await initializeDefaultSkills();

	// Proxy disabled — CORS is handled locally via declarativeNetRequest rules
	await storage.settings.set("proxy.enabled", false);

	// Create ChatPanel
	chatPanel = new ChatPanel();

	// Handle test steps
	if (await testSteps()) {
		return;
	}

	// Which chat should this panel show?
	//  - ?session=<id>  : explicit (a history-list click)
	//  - ?new=true      : a fresh task on this tab (New chat)
	//  - otherwise      : the task already bound to this tab, if any
	const urlParams = new URLSearchParams(window.location.search);
	let sessionIdFromUrl = urlParams.get("session");
	const isNewSession = urlParams.get("new") === "true";

	if (!sessionIdFromUrl && !isNewSession && homeTabId !== undefined && storage.sessions) {
		const boundId = await sessionIdForTab(homeTabId);
		// The tab's session id is the saved chat id once persisted; an unsaved one has no
		// storage entry, so only restore ids the sessions store actually knows.
		if (boundId && !boundId.startsWith("tab-") && !boundId.startsWith("temp-")) {
			sessionIdFromUrl = boundId;
			updateUrl(boundId);
		}
	}

	if (sessionIdFromUrl && storage.sessions) {
		const sessionData = await storage.sessions.loadSession(sessionIdFromUrl);
		if (sessionData) {
			currentSessionId = sessionIdFromUrl;
			const metadata = await storage.sessions.getMetadata(sessionIdFromUrl);
			currentTitle = metadata?.title || "";

			const compaction = await storage.settings.get<Compaction>(compactionKey(sessionIdFromUrl));
			await createAgent(
				{
					systemPrompt: SYSTEM_PROMPT,
					model: sessionData.model,
					thinkingLevel: sessionData.thinkingLevel,
					messages: sessionData.messages,
					tools: [],
				},
				true,
				compaction ?? undefined,
			);

			interruptedRun = await wasInterrupted(sessionIdFromUrl);
			renderApp();
			return;
		} else {
			// Session doesn't exist, redirect to new session
			newSession();
			return;
		}
	}

	// No session - create new agent with welcome message
	await createAgent();

	// Add welcome message for new sessions. With no provider connected it carries the
	// "Connect a provider" prompt (see registerWelcomeRenderer), so nothing is forced open.
	if (agent) {
		const welcomeMessage = createWelcomeMessage(tutorials);
		agent.appendMessage(welcomeMessage);
		// appendMessage emits no agent event, so the message list would keep the old array.
		chatPanel.agentInterface?.requestUpdate();
	}

	renderApp();
}

// Register custom user message renderer early, before any session loads
registerUserMessageRenderer();

initApp();
