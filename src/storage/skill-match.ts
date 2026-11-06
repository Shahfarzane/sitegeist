import { minimatch } from "minimatch";

/** The pattern of a skill that is not tied to a site. */
export const ANY_SITE = "*";

/** Check if a URL matches any of a skill's domain patterns, using glob matching. */
export function matchesAnyPattern(url: string, patterns: string[]): boolean {
	if (patterns.includes(ANY_SITE)) return true;
	try {
		const urlObj = new URL(url);
		const hostname = urlObj.hostname;
		const path = urlObj.pathname;

		for (const pattern of patterns) {
			const parts = pattern.split("/");
			const domainPattern = parts[0];
			const pathPattern = parts.length > 1 ? `/${parts.slice(1).join("/")}` : "";

			const normalizedHostname = hostname.replace(/^www\./, "");
			const normalizedPattern = domainPattern.replace(/^www\./, "");

			const domainMatches = minimatch(normalizedHostname, normalizedPattern, {
				nocase: true,
			});

			if (!pathPattern || pathPattern === "/") {
				if (domainMatches) return true;
			} else {
				const pathMatches = minimatch(path, pathPattern, { nocase: true });
				if (domainMatches && pathMatches) return true;
			}
		}

		return false;
	} catch {
		return false;
	}
}
