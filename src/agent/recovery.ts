/**
 * What to do with a turn that failed. Rate limits and overloaded servers pass on their own, and
 * a chat that outgrew the context window can be summarized and continued; neither should end a
 * run the user walked away from.
 */

import { type AssistantMessage, isContextOverflow } from "@mariozechner/pi-ai";

export type Failure = "overflow" | "transient";

export const MAX_RETRIES = 4;

const TRANSIENT =
	/\b(408|425|429|500|502|503|504|520|522|524|529)\b|rate.?limit|too many requests|overloaded|temporarily unavailable|service unavailable|timed? ?out|econnreset|etimedout|socket hang up|fetch failed|failed to fetch|network ?error|connection (error|closed|reset)|stream (ended|closed|error)/i;
/** Limits that do not pass by waiting a few seconds. */
const PERMANENT = /usage limit|quota|billing|credit|insufficient|invalid.{0,12}(api )?key|unauthori[sz]ed|forbidden/i;

export function classifyFailure(message: AssistantMessage, contextWindow?: number): Failure | undefined {
	if (message.stopReason !== "error") return undefined;
	if (isContextOverflow(message, contextWindow)) return "overflow";
	const text = message.errorMessage ?? "";
	if (PERMANENT.test(text)) return undefined;
	return TRANSIENT.test(text) ? "transient" : undefined;
}

/** Exponential with jitter; `attempt` starts at 1. A server's retry hint wins when it is longer. */
export function backoffMs(attempt: number, errorMessage = "", random = Math.random): number {
	const base = Math.min(30000, 1000 * 2 ** attempt);
	const hint = /retry[- ]?after[^\d]{0,12}(\d+(?:\.\d+)?)\s*(ms|s(?:ec\w*)?)?/i.exec(errorMessage);
	const hinted = hint ? Number(hint[1]) * (hint[2]?.toLowerCase() === "ms" ? 1 : 1000) : 0;
	return Math.min(60000, Math.max(base, hinted)) + Math.round(random() * 500);
}
