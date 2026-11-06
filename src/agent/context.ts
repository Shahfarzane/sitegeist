/**
 * What the model sees of a chat. The stored chat stays complete; these functions build the
 * view sent on each turn. Without them every screenshot and tool result is re-sent forever,
 * and a long chat ends in a context overflow.
 *
 * Elision moves in steps rather than a sliding window: the view of old messages only changes
 * when a step is crossed, so a provider's prompt cache keeps matching in between.
 */

import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { ImageContent, TextContent, ToolResultMessage } from "@mariozechner/pi-ai";

export interface PruneOptions {
	/** Newest tool-result images that always stay. */
	keepImages: number;
	/** Images are dropped in batches of this size. */
	imageStep: number;
	/** Newest tool results that always stay whole. */
	keepToolResults: number;
	/** Tool results are shortened in batches of this size. */
	toolResultStep: number;
	/** Length an old tool result's text is cut to. */
	maxOldToolChars: number;
}

export const DEFAULT_PRUNE: PruneOptions = {
	keepImages: 4,
	imageStep: 6,
	keepToolResults: 12,
	toolResultStep: 8,
	maxOldToolChars: 1500,
};

const IMAGE_PLACEHOLDER = "[Older screenshot removed to save context. Take a new one if you need to see the page.]";

function isToolResult(message: AgentMessage): message is ToolResultMessage {
	return message.role === "toolResult";
}

/** How many of `total` items, oldest first, fall out, moving only in whole steps. */
function steppedCount(total: number, keep: number, step: number): number {
	const excess = total - keep;
	if (excess <= 0) return 0;
	return Math.floor(excess / step) * step;
}

function shorten(text: string, max: number): string {
	if (text.length <= max) return text;
	return `${text.slice(0, max)}\n[... ${text.length - max} more characters removed to save context]`;
}

/** The view of `messages` with old images and long old tool output removed. Never mutates. */
export function pruneContext(messages: AgentMessage[], options: PruneOptions = DEFAULT_PRUNE): AgentMessage[] {
	let images = 0;
	let results = 0;
	for (const m of messages) {
		if (!isToolResult(m)) continue;
		results++;
		images += m.content.filter((c) => c.type === "image").length;
	}
	let imagesToDrop = steppedCount(images, options.keepImages, options.imageStep);
	let resultsToShorten = steppedCount(results, options.keepToolResults, options.toolResultStep);
	if (imagesToDrop === 0 && resultsToShorten === 0) return messages;

	return messages.map((m) => {
		if (m.role === "navigation") {
			// The skills list of a page the agent left long ago is noise; refs to it are not needed.
			return resultsToShorten > 0 && m.skillsOutput ? { ...m, skillsOutput: "" } : m;
		}
		if (!isToolResult(m)) return m;
		const shortenThis = resultsToShorten > 0;
		if (shortenThis) resultsToShorten--;
		let changed = false;
		const content: Array<TextContent | ImageContent> = m.content.map((c) => {
			if (c.type === "image") {
				if (imagesToDrop <= 0) return c;
				imagesToDrop--;
				changed = true;
				return { type: "text", text: IMAGE_PLACEHOLDER };
			}
			if (!shortenThis) return c;
			const text = shorten(c.text, options.maxOldToolChars);
			if (text === c.text) return c;
			changed = true;
			return { ...c, text };
		});
		return changed ? { ...m, content } : m;
	});
}

/** Rough size in tokens: about 4 characters per token, a fixed cost per image. */
const IMAGE_TOKENS = 1600;

function contentTokens(content: unknown): number {
	if (typeof content === "string") return Math.ceil(content.length / 4);
	if (!Array.isArray(content)) return 0;
	let tokens = 0;
	for (const block of content as Array<Record<string, unknown>>) {
		if (block.type === "image") tokens += IMAGE_TOKENS;
		else if (block.type === "text") tokens += Math.ceil(String(block.text ?? "").length / 4);
		else if (block.type === "thinking") tokens += Math.ceil(String(block.thinking ?? "").length / 4);
		else if (block.type === "toolCall") tokens += Math.ceil(JSON.stringify(block.arguments ?? {}).length / 4);
	}
	return tokens;
}

export function messageTokens(message: AgentMessage): number {
	if (message.role === "navigation") return 60 + Math.ceil((message.skillsOutput ?? "").length / 4);
	if (message.role === "user" || message.role === "assistant" || message.role === "toolResult") {
		return 4 + contentTokens(message.content);
	}
	return 0;
}

export function estimateTokens(messages: AgentMessage[]): number {
	let total = 0;
	for (const m of messages) total += messageTokens(m);
	return total;
}

export interface Compaction {
	/** Index into the full chat of the first message still sent as is. */
	cut: number;
	/** Stands in for everything before `cut`. */
	summary: string;
}

/**
 * Where to cut so the newest `keepTokens` stay. A tool result never starts the kept part: it
 * would arrive without the call it answers, which providers reject. Undefined when the cut
 * would not move past `after`.
 */
export function findCut(messages: AgentMessage[], keepTokens: number, after = 0): number | undefined {
	let tokens = 0;
	let cut = messages.length;
	for (let i = messages.length - 1; i > after; i--) {
		tokens += messageTokens(messages[i]);
		cut = i;
		if (tokens >= keepTokens) break;
	}
	while (cut < messages.length && isToolResult(messages[cut])) cut++;
	if (cut >= messages.length || cut <= after) return undefined;
	return cut;
}

function summaryMessage(summary: string): AgentMessage {
	return {
		role: "user",
		content: [
			{
				type: "text",
				text: `<conversation-summary>\nThe earlier part of this conversation was summarized to save context. Treat this as what happened so far, and continue from it.\n\n${summary}\n</conversation-summary>`,
			},
		],
		timestamp: 0,
	};
}

/** The chat as the model should see it after `compaction`. */
export function applyCompaction(messages: AgentMessage[], compaction: Compaction | undefined): AgentMessage[] {
	if (!compaction) return messages;
	return [summaryMessage(compaction.summary), ...messages.slice(Math.min(compaction.cut, messages.length))];
}

const SUMMARY_TOOL_CHARS = 1200;

/** Plain-text transcript of messages for the summarizer. */
export function transcript(messages: AgentMessage[]): string {
	const lines: string[] = [];
	const textOf = (content: unknown): string => {
		if (typeof content === "string") return content;
		if (!Array.isArray(content)) return "";
		return (content as Array<Record<string, unknown>>)
			.map((c) => {
				if (c.type === "text") return String(c.text ?? "");
				if (c.type === "image") return "[image]";
				if (c.type === "toolCall")
					return `[called ${String(c.name)} ${JSON.stringify(c.arguments ?? {}).slice(0, 400)}]`;
				return "";
			})
			.filter(Boolean)
			.join("\n");
	};
	for (const m of messages) {
		if (m.role === "user") lines.push(`USER: ${textOf(m.content)}`);
		else if (m.role === "assistant") lines.push(`ASSISTANT: ${textOf(m.content)}`);
		else if (m.role === "toolResult")
			lines.push(`TOOL ${m.toolName}: ${shorten(textOf(m.content), SUMMARY_TOOL_CHARS)}`);
		else if (m.role === "navigation") lines.push(`NAVIGATED: ${m.title} ${m.url}`);
	}
	return lines.join("\n\n");
}

export const SUMMARY_SYSTEM_PROMPT =
	"You summarize a browser agent's conversation so it can continue the task without the original messages. Be factual and specific.";

export function summaryPrompt(previous: string | undefined, text: string): string {
	return [
		"Summarize the conversation below for the agent that continues it. Use these sections:",
		"Goal: what the user asked for, including constraints and later corrections.",
		"Done: what has been completed, with the results that matter (values found, pages changed, files made).",
		"State: open tabs and URLs, what is logged in or filled in, artifacts that exist.",
		"Next: what remains, in order.",
		"Keep names, URLs, numbers and exact wording of requests. Leave out tool mechanics.",
		previous ? `\nSummary of the conversation before this part:\n${previous}` : "",
		`\n<conversation>\n${text}\n</conversation>`,
	].join("\n");
}
