/**
 * Files pages downloaded, so an agent can find what a click saved. `downloads` is an optional
 * permission (it shows an install warning; a required one would disable the extension on update),
 * turned on under Settings > Downloads.
 */

export interface DownloadEntry {
	id: number;
	/** Absolute path on disk. */
	path: string;
	url: string;
	mimeType: string;
	state: string;
	bytes: number;
	startedAt: string;
	error?: string;
}

export function downloadsGranted(): Promise<boolean> {
	return chrome.permissions.contains({ permissions: ["downloads"] }).catch(() => false);
}

export const DOWNLOADS_OFF =
	"Downloads are off for sitegeist: the user can turn them on under Settings > Downloads in the side panel.";

/** Newest first. */
export async function recentDownloads(limit = 20): Promise<DownloadEntry[]> {
	if (!(await downloadsGranted())) throw new Error(DOWNLOADS_OFF);
	const items = await chrome.downloads.search({ orderBy: ["-startTime"], limit: Math.max(1, Math.min(limit, 100)) });
	return items.map((d) => ({
		id: d.id,
		path: d.filename,
		url: d.finalUrl || d.url,
		mimeType: d.mime,
		state: d.state,
		bytes: d.bytesReceived,
		startedAt: d.startTime,
		...(d.error ? { error: d.error } : {}),
	}));
}
