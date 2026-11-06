/**
 * 1Password logins through its CLI. `op` asks the 1Password app, which prompts the user (Touch ID)
 * before it answers, so the approval stays in 1Password's hands. Values leave this process only
 * for a page whose address matches the item.
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";

const OP_TIMEOUT_MS = 90000;
const SETUP_HINT =
	"Install the 1Password CLI and turn on 1Password > Settings > Developer > Integrate with 1Password CLI.";

export interface LoginChoice {
	id: string;
	title: string;
	username?: string;
}

export interface LoginValues {
	title: string;
	username?: string;
	password?: string;
	otp?: string;
}

interface OpField {
	id?: string;
	type?: string;
	purpose?: string;
	value?: string;
	totp?: string;
}

interface OpItem {
	id: string;
	title: string;
	urls?: Array<{ href?: string }>;
	fields?: OpField[];
	additional_information?: string;
}

function opPath(): string {
	const candidates = [process.env.SITEGEIST_OP_PATH, "/opt/homebrew/bin/op", "/usr/local/bin/op"];
	return candidates.find((path) => path && existsSync(path)) ?? "op";
}

function op(args: string[]): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile(opPath(), args, { timeout: OP_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
			if (!error) {
				resolve(stdout);
				return;
			}
			const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
			reject(new Error(missing ? `1Password CLI not found. ${SETUP_HINT}` : stderr.trim() || error.message));
		});
	});
}

function hostOf(url: string | undefined): string | undefined {
	if (!url) return undefined;
	try {
		// Items often store a bare domain.
		return new URL(url.includes("://") ? url : `https://${url}`).hostname.toLowerCase().replace(/^www\./, "");
	} catch {
		return undefined;
	}
}

/** Same host, or one is a subdomain of the other. example.com.evil.test matches nothing. */
export function hostsMatch(itemUrl: string | undefined, pageUrl: string): boolean {
	const item = hostOf(itemUrl);
	const page = hostOf(pageUrl);
	if (!item || !page) return false;
	return item === page || page.endsWith(`.${item}`) || item.endsWith(`.${page}`);
}

function itemMatches(item: OpItem, pageUrl: string): boolean {
	return (item.urls ?? []).some((u) => hostsMatch(u.href, pageUrl));
}

/** Logins saved for this page. */
export async function searchLogins(pageUrl: string): Promise<LoginChoice[]> {
	const items = JSON.parse(await op(["item", "list", "--categories", "Login", "--format", "json"])) as OpItem[];
	return items
		.filter((item) => itemMatches(item, pageUrl))
		.map((item) => ({ id: item.id, title: item.title, username: item.additional_information }));
}

/** The values of one login, for this page only. */
export async function readLogin(id: string, pageUrl: string): Promise<LoginValues> {
	const item = JSON.parse(await op(["item", "get", id, "--format", "json", "--reveal"])) as OpItem;
	if (!itemMatches(item, pageUrl)) throw new Error(`${item.title} is not saved for this site`);
	const field = (test: (f: OpField) => boolean) => item.fields?.find(test);
	return {
		title: item.title,
		username: field((f) => f.purpose === "USERNAME" || f.id === "username")?.value,
		password: field((f) => f.purpose === "PASSWORD" || f.id === "password")?.value,
		otp: field((f) => f.type === "OTP")?.totp,
	};
}
