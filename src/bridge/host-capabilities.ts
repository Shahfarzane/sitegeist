/**
 * What the native host on this computer can do. The extension updates by itself, the CLI does
 * not, and a host from before a feature never answers its messages: it takes them for a bridge
 * connection and opens a stray socket. So the extension asks first, in the one message every
 * host answers. An old host looks the name up as a login provider and reports an error.
 */

import { HOST_CAPABILITIES_PROVIDER, type HostCredentialsResponse, NATIVE_HOST_NAME } from "./protocol.js";

const CACHE_MS = 60000;
/** A failed probe may be a host that was just restarting: ask again soon. */
const RETRY_MS = 5000;
/** The oldest hosts do not answer this message at all. */
const ANSWER_MS = 3000;

let cached: { at: number; capabilities: Promise<string[]> } | undefined;

export function hostCapabilities(): Promise<string[]> {
	if (cached && Date.now() - cached.at < CACHE_MS) return cached.capabilities;
	const answer = (
		chrome.runtime.sendNativeMessage(NATIVE_HOST_NAME, {
			type: "credentials",
			provider: HOST_CAPABILITIES_PROVIDER,
		}) as Promise<HostCredentialsResponse | undefined>
	).then(
		(response) => response?.capabilities ?? [],
		() => [] as string[],
	);
	const capabilities = Promise.race([
		answer,
		new Promise<string[]>((resolve) => setTimeout(() => resolve([]), ANSWER_MS)),
	]);
	const entry = { at: Date.now(), capabilities };
	cached = entry;
	void capabilities.then((found) => {
		if (found.length === 0) entry.at = Date.now() - CACHE_MS + RETRY_MS;
	});
	return capabilities;
}
