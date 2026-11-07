/**
 * The self-hosted release on this machine: scripts/release-crx.sh writes the signed .crx and
 * updates.xml here, and the packaged manifest's update_url points at that updates.xml.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export function updateDir(): string {
	// The e2e suite publishes into a folder of its own.
	return process.env.SITEGEIST_UPDATE_DIR || join(homedir(), ".local", "share", "sitegeist", "extension");
}

export function updateManifestPath(): string {
	return join(updateDir(), "updates.xml");
}

export function updateManifestUrl(): string {
	return pathToFileURL(updateManifestPath()).href;
}

/** The version in an update manifest (`<updatecheck ... version="1.2.3" />`). */
export function parsePublishedVersion(xml: string): string | undefined {
	const tag = /<updatecheck\b[^>]*>/.exec(xml)?.[0];
	return tag ? /\bversion="([0-9.]+)"/.exec(tag)?.[1] : undefined;
}

/** The release published on this machine, if there is one. */
export function publishedVersion(): string | undefined {
	const path = updateManifestPath();
	if (!existsSync(path)) return undefined;
	try {
		return parsePublishedVersion(readFileSync(path, "utf8"));
	} catch {
		return undefined;
	}
}
