/**
 * Permission prompts for `sitegeist mcp`. In "ask" mode the extension holds a navigation until
 * someone answers its permission_request event. The question goes back to the harness as the
 * tool call's own result (`input_required`): the call returns at once while its bridge request
 * keeps waiting in the extension, and the client's retry carries the answer, which is sent on
 * with permission.respond before the call resumes. On 2025-era connections the SDK's legacy shim
 * turns the same result into an elicitation/create request, so one path serves both eras.
 */

import { randomBytes, randomUUID } from "node:crypto";
import {
	acceptedContent,
	CLIENT_CAPABILITIES_META_KEY,
	type CallToolResult,
	type ClientCapabilities,
	createRequestStateCodec,
	type InputRequiredResult,
	inputRequired,
	type ServerContext,
} from "@modelcontextprotocol/server";
import { z } from "zod";

export type Decision = "allow_once" | "allow_host" | "deny";

export interface PermissionRequest {
	/** The extension's id for the question, answered with permission.respond. */
	requestId: string;
	host: string;
	/** The bridge request waiting on the answer; extensions before this field leave it out. */
	callId?: number;
}

/** Records the id of every bridge request a tool call sends. */
export type Track = (callId: number) => void;

interface PromptState {
	invocation: string;
	requestId: string;
}

const ANSWER_KEY = "decision";
const AnswerSchema = z.object({ decision: z.enum(["allow_host", "allow_once", "deny"]) });

/** How long an unanswered question stays answerable; the extension gives up on the navigation sooner. */
const ANSWER_TTL_SECONDS = 600;

/** One tool call in flight. It outlives the MCP request that started it while a question is open. */
class Invocation {
	readonly callIds = new Set<number>();
	readonly done: Promise<CallToolResult>;
	settled = false;
	/** Returned a question and waits for the client's retry. */
	suspended = false;
	private readonly questions: PermissionRequest[] = [];
	private waiters: Array<() => void> = [];

	constructor(
		readonly id: string,
		run: (track: Track) => Promise<CallToolResult>,
	) {
		// Started a microtask later, once the caller has registered it, so a question raised at once finds it.
		this.done = Promise.resolve()
			.then(() => run((callId) => this.callIds.add(callId)))
			.catch((err: unknown): CallToolResult => ({
				content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }],
				isError: true,
			}))
			.finally(() => {
				this.settled = true;
				this.wakeAll();
			});
	}

	ask(question: PermissionRequest): void {
		this.questions.push(question);
		this.wakeAll();
	}

	private wakeAll(): void {
		const waiters = this.waiters;
		this.waiters = [];
		for (const wake of waiters) wake();
	}

	/** The result once the call ends, or the next question it is waiting on. */
	async next(): Promise<{ done: CallToolResult } | { ask: PermissionRequest }> {
		for (;;) {
			// A call that already ended (the extension timed it out) has nothing left to ask.
			if (this.settled) return { done: await this.done };
			const question = this.questions.shift();
			if (question) return { ask: question };
			await new Promise<void>((resolve) => this.waiters.push(resolve));
		}
	}
}

/**
 * The client's capabilities: a 2026 request carries them in its envelope, a 2025 connection
 * declared them at initialize.
 */
export function clientCapabilities(
	ctx: ServerContext,
	declaredAtInitialize: ClientCapabilities | undefined,
): ClientCapabilities | undefined {
	// The SDK validated the envelope at dispatch; its published type does not name the keys.
	const envelope: Record<string, unknown> | undefined = ctx.mcpReq.envelope;
	const fromEnvelope = envelope?.[CLIENT_CAPABILITIES_META_KEY];
	return fromEnvelope && typeof fromEnvelope === "object" ? (fromEnvelope as ClientCapabilities) : declaredAtInitialize;
}

/** Whether the client can show a form question (an empty `elicitation: {}` means form). */
export function canShowForm(capabilities: ClientCapabilities | undefined): boolean {
	const elicitation = capabilities?.elicitation;
	if (!elicitation) return false;
	return elicitation.form !== undefined || elicitation.url === undefined;
}

export class PermissionPrompts {
	private readonly running = new Map<string, Invocation>();
	/** Seals requestState: it travels through the client, so a forged one must not resume a call. */
	readonly codec = createRequestStateCodec<PromptState>({ key: randomBytes(32), ttlSeconds: ANSWER_TTL_SECONDS });

	constructor(
		private readonly respond: (requestId: string, decision: Decision) => Promise<void>,
		private readonly onHeadlessDeny: (host: string) => void,
	) {}

	/** Hands a permission_request to the tool call it belongs to. False when none is running. */
	raise(question: PermissionRequest): boolean {
		const live = [...this.running.values()].filter((i) => !i.settled);
		const { callId } = question;
		const owner =
			callId !== undefined
				? live.find((i) => i.callIds.has(callId))
				: // Extensions before callId run one request per client at a time: the oldest live call holds it.
					live[0];
		if (!owner) return false;
		owner.ask(question);
		return true;
	}

	/** Run one tool call, or resume one on the client's retry. */
	async handle(
		ctx: ServerContext,
		declaredAtInitialize: ClientCapabilities | undefined,
		start: (track: Track) => Promise<CallToolResult>,
	): Promise<CallToolResult | InputRequiredResult> {
		const capabilities = clientCapabilities(ctx, declaredAtInitialize);
		const state = ctx.mcpReq.requestState<PromptState>();
		let invocation: Invocation;
		if (state) {
			const answer = acceptedContent(ctx.mcpReq.inputResponses, ANSWER_KEY, AnswerSchema);
			// Declined, cancelled or malformed answers deny, as a closed prompt always did.
			await this.respond(state.requestId, answer?.decision ?? "deny");
			const resumed = this.running.get(state.invocation);
			if (!resumed) {
				return {
					content: [{ type: "text", text: "The browser request ended before the answer arrived. Call the tool again." }],
					isError: true,
				};
			}
			resumed.suspended = false;
			invocation = resumed;
		} else {
			invocation = new Invocation(randomUUID(), start);
			this.running.set(invocation.id, invocation);
		}

		for (;;) {
			const step = await invocation.next();
			if ("done" in step) {
				this.running.delete(invocation.id);
				return step.done;
			}
			const question = step.ask;
			if (!canShowForm(capabilities)) {
				// Headless runs: deny now instead of stalling; the error tells the model how to allow it.
				this.onHeadlessDeny(question.host);
				await this.respond(question.requestId, "deny");
				continue;
			}
			this.suspend(invocation);
			return inputRequired({
				inputRequests: {
					[ANSWER_KEY]: inputRequired.elicit({
						message: `sitegeist: the browser agent wants to open ${question.host}. Allow?`,
						requestedSchema: {
							type: "object",
							properties: {
								decision: {
									type: "string",
									title: "Decision",
									enum: ["allow_host", "allow_once", "deny"],
									enumNames: [`Allow ${question.host} from now on`, "Allow once", "Deny"],
								},
							},
							required: ["decision"],
						},
					}),
				},
				requestState: await this.codec.mint({ invocation: invocation.id, requestId: question.requestId }),
			});
		}
	}

	/** Keep a waiting call for its retry; drop it once it ended and the answer can no longer come. */
	private suspend(invocation: Invocation): void {
		invocation.suspended = true;
		void invocation.done.then(() => {
			setTimeout(() => {
				if (invocation.suspended) this.running.delete(invocation.id);
			}, ANSWER_TTL_SECONDS * 1000).unref();
		});
	}
}
