/**
 * Updates come from the Chrome Web Store, which the browser polls on its own schedule (every
 * few hours). `sitegeist update` asks for one check now, through bridge.update.
 *
 * chrome.runtime.requestUpdateCheck is throttled per browser session: a call that ends without an
 * update arms a 5-hour backoff (kDefaultUpdateFrequency in Chromium's
 * chrome_runtime_api_delegate.cc), and further calls answer `throttled`. So nothing here checks on
 * a timer or at startup; the browser's own scheduled checks stay the way updates normally arrive.
 */
const LEGACY_ALARM = "self-update-check";

/** Chrome's answer: `update_available`, `no_update` or `throttled`. */
export interface UpdateCheck {
	status: string;
	version?: string;
}

/** Ask Chrome for an update check now; onUpdateAvailable applies what it finds. */
export async function checkForUpdate(log: (line: string) => void, reason: string): Promise<UpdateCheck> {
	const { status, version } = await chrome.runtime.requestUpdateCheck();
	log(`update check (${reason}): ${status}${version ? ` ${version}` : ""}`);
	return { status, version };
}

export function startSelfUpdate(log: (line: string) => void): void {
	chrome.runtime.onUpdateAvailable.addListener((details) => {
		// The bridge's native port keeps the worker alive, so Chrome would never find it idle.
		log(`update ${details.version} available, reloading`);
		chrome.runtime.reload();
	});
	// Earlier releases checked every 30 minutes, which kept the backoff armed.
	chrome.alarms.clear(LEGACY_ALARM).catch(() => undefined);
}
