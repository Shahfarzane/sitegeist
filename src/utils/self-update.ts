/**
 * Keep a self-hosted release current without waiting for Chrome's own schedule (hours).
 *
 * chrome.runtime.requestUpdateCheck is throttled per browser session: every call that ends
 * without an update arms a 5-hour backoff (kDefaultUpdateFrequency in Chromium's
 * chrome_runtime_api_delegate.cc), so a speculative check at startup or on a timer made the
 * push after a real release answer `throttled`. The extension therefore asks only when the
 * native host has said a newer version is published: on connect (the host reads updates.xml)
 * and from `sitegeist update`. Chrome's own scheduled checks stay as the fallback.
 */
const LEGACY_ALARM = "self-update-check";

/** Chrome's answer (`update_available`, `no_update`, `throttled`), or `current` when no check was needed. */
export interface UpdateCheck {
	status: string;
	version?: string;
}

/** True when `published` is a higher dotted version than `installed`. */
export function isNewerVersion(published: string, installed: string): boolean {
	const a = published.split(".").map((part) => Number.parseInt(part, 10));
	const b = installed.split(".").map((part) => Number.parseInt(part, 10));
	if ([...a, ...b].some((n) => !Number.isFinite(n))) return false;
	for (let i = 0; i < Math.max(a.length, b.length); i++) {
		const diff = (a[i] ?? 0) - (b[i] ?? 0);
		if (diff !== 0) return diff > 0;
	}
	return false;
}

/**
 * Ask Chrome for the update only when `published` is newer than what runs, so a check never
 * comes back empty and arms the backoff. Without a version (an older CLI), check anyway.
 */
export async function checkForUpdate(
	published: string | undefined,
	log: (line: string) => void,
	reason: string,
): Promise<UpdateCheck> {
	const installed = chrome.runtime.getManifest().version;
	if (published !== undefined && !isNewerVersion(published, installed)) return { status: "current" };
	const { status, version } = await chrome.runtime.requestUpdateCheck();
	log(
		`update check (${reason}): ${status}${version ? ` ${version}` : ""}${published ? ` (published ${published})` : ""}`,
	);
	return { status, version };
}

export function startSelfUpdate(log: (line: string) => void): void {
	chrome.runtime.onUpdateAvailable.addListener((details) => {
		// The bridge's native port keeps the worker alive, so Chrome would never find it idle.
		log(`update ${details.version} available, reloading`);
		chrome.runtime.reload();
	});
	// Releases before this one checked every 30 minutes, which kept the backoff armed.
	chrome.alarms.clear(LEGACY_ALARM).catch(() => undefined);
}
