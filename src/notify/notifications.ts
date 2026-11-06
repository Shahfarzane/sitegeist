/**
 * Desktop notifications, shown by the service worker. The agent works in hidden tabs, so without
 * these a task that finishes or waits for the user does so unnoticed.
 *
 * `notifications` is an optional permission on purpose: adding a permission with an install
 * warning makes Chrome disable the extension on update until someone re-approves it, on every
 * browser, and the bridge goes down with it.
 */

const ENABLED_KEY = "notify_enabled";
const SOUND_KEY = "notify_sound";
const ID_PREFIX = "sitegeist-notify";

export type NotifyKind = "done" | "failed" | "needs-you";

export interface NotifyRequest {
	kind: NotifyKind;
	title: string;
	message: string;
	/** Clicking the notification shows this tab. */
	tabId?: number;
}

export interface NotifySettings {
	/** The browser granted the permission. */
	granted: boolean;
	enabled: boolean;
	sound: boolean;
}

export async function notifySettings(): Promise<NotifySettings> {
	const [granted, stored] = await Promise.all([
		chrome.permissions.contains({ permissions: ["notifications"] }),
		chrome.storage.local.get([ENABLED_KEY, SOUND_KEY]),
	]);
	return { granted, enabled: stored[ENABLED_KEY] !== false, sound: stored[SOUND_KEY] !== false };
}

export function setNotifyEnabled(enabled: boolean): Promise<void> {
	return chrome.storage.local.set({ [ENABLED_KEY]: enabled });
}

export function setNotifySound(sound: boolean): Promise<void> {
	return chrome.storage.local.set({ [SOUND_KEY]: sound });
}

let creatingOffscreen: Promise<void> | undefined;

/** The offscreen document, created on first use and closed by Chrome when it goes quiet. */
export async function ensureOffscreen(): Promise<void> {
	if (await chrome.offscreen.hasDocument()) return;
	creatingOffscreen ??= chrome.offscreen
		.createDocument({
			url: "offscreen.html",
			reasons: ["AUDIO_PLAYBACK", "WORKERS", "BLOBS"],
			justification: "Notification sounds and encoding screen recordings off the main thread",
		})
		.catch((err: Error) => {
			if (!err.message.includes("Only a single offscreen")) throw err;
		})
		.finally(() => {
			creatingOffscreen = undefined;
		});
	await creatingOffscreen;
}

async function playChime(): Promise<void> {
	await ensureOffscreen();
	await chrome.runtime.sendMessage({ target: "offscreen", type: "chime" }).catch(() => undefined);
}

/** Show a notification if the user wants them. False when nothing was shown. */
export async function showNotification(request: NotifyRequest): Promise<boolean> {
	const settings = await notifySettings();
	if (!settings.granted || !settings.enabled) return false;
	const id = `${ID_PREFIX}:${request.tabId ?? "none"}:${Date.now()}`;
	await chrome.notifications.create(id, {
		type: "basic",
		iconUrl: chrome.runtime.getURL("icon-128.png"),
		title: request.title,
		message: request.message.slice(0, 200),
		requireInteraction: request.kind === "needs-you",
	});
	if (settings.sound) await playChime().catch((err) => console.warn("[Notify] sound failed:", err));
	return true;
}

async function onClicked(id: string): Promise<void> {
	if (!id.startsWith(`${ID_PREFIX}:`)) return;
	chrome.notifications.clear(id);
	const tabId = Number(id.split(":")[1]);
	if (!Number.isInteger(tabId)) return;
	const tab = await chrome.tabs.update(tabId, { active: true }).catch(() => undefined);
	if (tab?.windowId !== undefined) await chrome.windows.update(tab.windowId, { focused: true });
}

let clicksInstalled = false;

function installClicks(): void {
	if (clicksInstalled || !chrome.notifications) return;
	clicksInstalled = true;
	chrome.notifications.onClicked.addListener((id) => void onClicked(id));
}

/** Wire notifications into the service worker. The API only exists once it was granted. */
export function startNotifications(): void {
	installClicks();
	chrome.permissions.onAdded.addListener(() => installClicks());
	chrome.runtime.onMessage.addListener((message: { type?: string; request?: NotifyRequest }) => {
		if (message?.type === "sitegeist-notify" && message.request) {
			showNotification(message.request).catch((err) => console.warn("[Notify] failed:", err));
		}
	});
}

/**
 * From a panel: notify unless the user can see it. Focus alone says too little: someone reading
 * the panel while their cursor sits in the page next to it has the panel in view.
 */
export async function notifyFromPanel(request: NotifyRequest): Promise<void> {
	if (document.visibilityState === "visible") {
		const window = await chrome.windows.getCurrent().catch(() => undefined);
		if (window?.focused) return;
	}
	await chrome.runtime.sendMessage({ type: "sitegeist-notify", request }).catch(() => undefined);
}
