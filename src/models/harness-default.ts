/** The model the user's coding CLI is set to, for providers that CLI logs in to. */

import type { Model } from "@mariozechner/pi-ai";
import { hostCapabilities } from "../bridge/host-capabilities.js";
import { CAPABILITY_HARNESS_MODELS, type HarnessModels, NATIVE_HOST_NAME } from "../bridge/protocol.js";

/** Claude Code aliases that name a family without saying so. */
const ALIASES: Record<string, string> = { best: "opus", opusplan: "opus" };
const FAMILIES = ["opus", "sonnet", "haiku"];

/** The numbers in a model id, leaving out dates: claude-opus-4-5-20251101 is [4, 5]. */
function version(id: string): number[] {
	return [...id.matchAll(/\d+/g)].map((m) => Number(m[0])).filter((n) => n < 100);
}

function newestFirst(a: Model<any>, b: Model<any>): number {
	const [x, y] = [version(a.id), version(b.id)];
	for (let i = 0; i < Math.max(x.length, y.length); i++) {
		const difference = (y[i] ?? -1) - (x[i] ?? -1);
		if (difference !== 0) return difference;
	}
	return a.id.length - b.id.length;
}

/**
 * Turns a CLI's model setting into a listed model: an exact id, or the newest of an alias's family.
 * A suffix like `[1m]` picks a context size, not a model. Unknown settings resolve to nothing, and
 * so does `default`, which leaves the choice to the CLI.
 */
export function resolveHarnessModel(setting: string, models: Model<any>[]): Model<any> | undefined {
	const name = setting.replace(/\[.*\]$/, "").trim();
	const exact = models.find((m) => m.id === name);
	if (exact) return exact;
	const family = ALIASES[name] ?? name;
	if (!FAMILIES.includes(family)) return undefined;
	return models.filter((m) => m.id.includes(family)).sort(newestFirst)[0];
}

/** Empty on a host from before this feature, or when the host cannot be reached. */
export async function harnessModels(): Promise<HarnessModels> {
	if (!(await hostCapabilities()).includes(CAPABILITY_HARNESS_MODELS)) return {};
	try {
		const answer = await chrome.runtime.sendNativeMessage(NATIVE_HOST_NAME, { type: "harness_models" });
		return (answer as HarnessModels | undefined) ?? {};
	} catch {
		return {};
	}
}
