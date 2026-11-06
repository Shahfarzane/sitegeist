import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { type SessionData, SessionsStore } from "@mariozechner/pi-web-ui";

/**
 * Extended SessionsStore that migrates old tool result messages from output to content format.
 */
export class SitegeistSessionsStore extends SessionsStore {
	async loadSession(id: string): Promise<SessionData | null> {
		const session = await super.loadSession(id);
		if (session) {
			return this.migrateSession(session);
		}
		return session;
	}

	async get(id: string): Promise<SessionData | null> {
		const session = await super.get(id);
		if (session) {
			return this.migrateSession(session);
		}
		return session;
	}

	async delete(id: string): Promise<void> {
		await super.delete(id);
		// The chat summary lives beside the chat (see agent/context-manager.ts).
		await this.getBackend().delete("settings", `compaction.${id}`);
	}

	private migrateSession(session: SessionData): SessionData {
		return {
			...session,
			messages: this.migrateToolResultMessages(session.messages),
		};
	}

	private migrateToolResultMessages(messages: AgentMessage[]): AgentMessage[] {
		return messages.map((msg) => {
			if (msg.role === "toolResult" && "output" in msg && !msg.content) {
				// Old format detected - migrate it
				const { output, ...rest } = msg as any;
				return {
					...rest,
					content: [{ type: "text", text: output }],
				};
			}
			return msg;
		});
	}
}
