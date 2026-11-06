/**
 * Tells a run that is going from one that died. The agent lives in the panel document, so closing
 * the panel ends it mid-task. A marker in storage says a chat was running; a Web Lock, which the
 * browser releases when the document goes away, says whether something still runs it.
 */

import type { AgentMessage } from "@mariozechner/pi-agent-core";

const markerKey = (sessionId: string) => `run.${sessionId}`;
const lockName = (sessionId: string) => `sitegeist-run-${sessionId}`;

export class RunTracker {
	private active?: { sessionId: string; release: () => void };

	/** Idempotent; called on every event of a run because the chat gets its id mid-run. */
	start(sessionId: string): void {
		if (this.active?.sessionId === sessionId) return;
		this.stop();
		let release: () => void = () => undefined;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		this.active = { sessionId, release };
		navigator.locks.request(lockName(sessionId), () => held).catch(() => undefined);
		chrome.storage.local.set({ [markerKey(sessionId)]: Date.now() }).catch(() => undefined);
	}

	stop(): void {
		if (!this.active) return;
		this.active.release();
		chrome.storage.local.remove(markerKey(this.active.sessionId)).catch(() => undefined);
		this.active = undefined;
	}
}

/** True when this chat was running and nothing runs it any more. */
export async function wasInterrupted(sessionId: string): Promise<boolean> {
	const key = markerKey(sessionId);
	const marker = (await chrome.storage.local.get(key))[key];
	if (marker === undefined) return false;
	const { held } = await navigator.locks.query();
	return !held?.some((lock) => lock.name === lockName(sessionId));
}

export function clearInterrupted(sessionId: string): Promise<void> {
	return chrome.storage.local.remove(markerKey(sessionId));
}

/** Tool calls the run never answered get a result, so the chat is valid to continue from. */
export function answerOpenToolCalls(messages: AgentMessage[]): AgentMessage[] {
	const answered = new Set<string>();
	for (const m of messages) if (m.role === "toolResult") answered.add(m.toolCallId);
	const open: AgentMessage[] = [];
	for (const m of messages) {
		if (m.role !== "assistant") continue;
		for (const block of m.content) {
			if (block.type !== "toolCall" || answered.has(block.id)) continue;
			open.push({
				role: "toolResult",
				toolCallId: block.id,
				toolName: block.name,
				isError: true,
				content: [
					{
						type: "text",
						text: "The panel closed before this finished, so its outcome is unknown. Check the page before repeating it.",
					},
				],
				timestamp: Date.now(),
			});
		}
	}
	return open.length > 0 ? [...messages, ...open] : messages;
}
