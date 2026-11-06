/**
 * Builds each turn's view of the chat, and summarizes older turns when the chat nears the
 * model's context window. The stored chat is never rewritten: the summary is kept beside it and
 * applied here, so the conversation on screen stays whole.
 */

import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { Model } from "@mariozechner/pi-ai";
import {
	applyCompaction,
	type Compaction,
	DEFAULT_PRUNE,
	estimateTokens,
	findCut,
	type PruneOptions,
	pruneContext,
	summaryPrompt,
	transcript,
} from "./context.js";

/** Share of the context window that triggers a summary. */
const COMPACT_AT = 0.8;
/** Share of the context window kept verbatim after a summary. */
const KEEP_SHARE = 0.3;
/** System prompt and tool definitions, which the messages do not show. */
const FIXED_OVERHEAD_TOKENS = 10000;

/** With nothing left to summarize, the last resort before an overflow. */
const TIGHT_PRUNE: PruneOptions = {
	keepImages: 1,
	imageStep: 1,
	keepToolResults: 3,
	toolResultStep: 1,
	maxOldToolChars: 400,
};

export interface ContextManagerOptions {
	model(): Model<any>;
	summarize(prompt: string, signal?: AbortSignal): Promise<string>;
	/** A new summary exists; persist it with the chat. */
	onCompaction(compaction: Compaction): void;
}

export class ContextManager {
	private compaction?: Compaction;

	constructor(
		private readonly options: ContextManagerOptions,
		initial?: Compaction,
	) {
		this.compaction = initial;
	}

	get current(): Compaction | undefined {
		return this.compaction;
	}

	private limit(): number {
		const window = this.options.model().contextWindow;
		return window > 0 ? window : 0;
	}

	private view(messages: AgentMessage[], prune: PruneOptions): AgentMessage[] {
		return pruneContext(applyCompaction(messages, this.compaction), prune);
	}

	/** The `transformContext` of the agent: what the model receives this turn. */
	async prepare(messages: AgentMessage[], signal?: AbortSignal): Promise<AgentMessage[]> {
		const view = this.view(messages, DEFAULT_PRUNE);
		const window = this.limit();
		if (!window || estimateTokens(view) + FIXED_OVERHEAD_TOKENS < window * COMPACT_AT) return view;
		await this.compact(messages, signal).catch((err) => {
			if (signal?.aborted) throw err;
			console.warn("[Context] summary failed:", err);
		});
		const compacted = this.view(messages, DEFAULT_PRUNE);
		if (estimateTokens(compacted) + FIXED_OVERHEAD_TOKENS < window * COMPACT_AT) return compacted;
		return this.view(messages, TIGHT_PRUNE);
	}

	/** Summarize everything older than the newest part. False when there was nothing to fold in. */
	async compact(messages: AgentMessage[], signal?: AbortSignal): Promise<boolean> {
		const keep = Math.floor(this.limit() * KEEP_SHARE);
		const previous = this.compaction;
		const cut = findCut(messages, keep, previous?.cut ?? 0);
		if (cut === undefined) return false;
		const older = messages.slice(previous?.cut ?? 0, cut);
		const summary = await this.options.summarize(summaryPrompt(previous?.summary, transcript(older)), signal);
		if (!summary.trim()) return false;
		this.compaction = { cut, summary: summary.trim() };
		this.options.onCompaction(this.compaction);
		return true;
	}
}
