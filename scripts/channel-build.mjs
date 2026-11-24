// What a build channel (src/channels.json) changes in the built extension. scripts/build.mjs
// applies these; test/channel-build.test.mts checks them without bundling anything.
//
// "production" is the Chrome Web Store item: its build is the source manifest and static files
// as they are. "dev" is a build loaded unpacked from a checkout beside the store copy: its own
// id (the public half of a second key; no private half is kept, an unpacked build needs none),
// name, marked icons and output folder, and a version that names the commit instead of bumping
// the tracked one.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** The channel table, and the one SITEGEIST_CHANNEL names (production when unset). */
export function readChannel(packageRoot, name = process.env.SITEGEIST_CHANNEL || "production") {
	const channels = JSON.parse(readFileSync(join(packageRoot, "src/channels.json"), "utf8"));
	const channel = channels[name];
	if (!channel) {
		throw new Error(`SITEGEIST_CHANNEL is "${name}"; it must be one of: ${Object.keys(channels).join(", ")}`);
	}
	return { name, channel, channels };
}

/** Chrome's id for a manifest `key` (base64 SPKI): the first 16 bytes of its SHA-256, written with a to p. */
export function extensionIdForKey(key) {
	const hex = createHash("sha256").update(Buffer.from(key, "base64")).digest("hex").slice(0, 32);
	return [...hex].map((c) => String.fromCharCode(97 + Number.parseInt(c, 16))).join("");
}

/**
 * The manifest a channel builds: the source with the channel's fields on top (each replaces the
 * whole top-level key), and the given version. Throws when the key does not give the channel's id,
 * so the table and the key cannot drift apart.
 */
export function channelManifest(source, channel, { version, versionName }) {
	const manifest = { ...source, ...channel.manifest, version };
	if (versionName) manifest.version_name = versionName;
	const id = extensionIdForKey(manifest.key);
	if (id !== channel.extensionId) {
		throw new Error(`the manifest key gives id ${id}, but src/channels.json says ${channel.extensionId}`);
	}
	return manifest;
}

/**
 * cors-rules.json for a channel. A rule limited to the production id as initiator (Anthropic's API
 * rejects calls that carry an extension Origin) names the channel's id instead. Production gets the
 * file unchanged, byte for byte.
 */
export function channelCorsRules(text, productionId, channelId) {
	const rules = JSON.parse(text);
	const bound = rules.filter((rule) => rule.condition?.initiatorDomains?.includes(productionId));
	if (bound.length === 0) throw new Error(`cors-rules.json has no rule for initiator ${productionId}`);
	if (channelId === productionId) return text;
	for (const rule of bound) {
		rule.condition.initiatorDomains = rule.condition.initiatorDomains.map((d) =>
			d === productionId ? channelId : d,
		);
	}
	return `${JSON.stringify(rules, null, "\t")}\n`;
}

/**
 * A dev build's version: `<major>.<minor>.<commits on HEAD>` as scripts/release-crx.sh makes it,
 * and a version_name that says dev and names the branch and commit. Without git (an export), the
 * source version and a plain "dev".
 */
export function devVersion(sourceVersion, git) {
	const base = String(sourceVersion).split(".").slice(0, 2).join(".");
	if (!git) return { version: sourceVersion, versionName: `${sourceVersion} dev` };
	const version = `${base}.${git.commits}`;
	const where = [git.branch, git.sha].filter(Boolean).join(" ");
	return { version, versionName: `${version} dev (${where}${git.modified ? ", modified" : ""})` };
}
