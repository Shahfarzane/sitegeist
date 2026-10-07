/**
 * Keep a self-hosted release current without waiting for Chrome's own schedule (hours): check
 * the update_url when the browser starts and every 30 minutes, and reload as soon as Chrome
 * has downloaded an update. Chrome applies updates only once an extension is idle, and the
 * bridge's native port keeps the worker alive for as long as the browser runs.
 */
const ALARM = "self-update-check";

export function startSelfUpdate(log: (line: string) => void): void {
	const check = (reason: string) => {
		chrome.runtime
			.requestUpdateCheck()
			.then(({ status, version }) => {
				if (status !== "no_update") log(`update check (${reason}): ${status}${version ? ` ${version}` : ""}`);
			})
			.catch(() => undefined);
	};

	chrome.runtime.onStartup.addListener(() => check("startup"));
	chrome.runtime.onUpdateAvailable.addListener((details) => {
		log(`update ${details.version} available, reloading`);
		chrome.runtime.reload();
	});
	chrome.alarms.onAlarm.addListener((alarm) => {
		if (alarm.name === ALARM) check("periodic");
	});
	// Re-creating an existing alarm would restart its period on every worker start.
	chrome.alarms.get(ALARM).then((existing) => {
		if (!existing) chrome.alarms.create(ALARM, { periodInMinutes: 30 });
	});
}
