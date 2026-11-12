// What the debugger's cookies action reports: names, domains and expiry, never a value.
// A cookie value is a credential, and tool results end up in session transcripts that are
// kept unredacted, so a value read here would be stored for good (2026-11-12).

/** The fields of chrome.cookies.Cookie this reads; a value, if present, is ignored. */
export interface CookieLike {
	name: string;
	domain: string;
	path: string;
	session?: boolean;
	expirationDate?: number;
	httpOnly?: boolean;
	secure?: boolean;
}

export interface CookieSummary {
	name: string;
	domain: string;
	path: string;
	/** ISO time, or "session" for a cookie that ends with the browser session. */
	expires: string;
	httpOnly: boolean;
	secure: boolean;
}

export function summarizeCookies(cookies: readonly CookieLike[]): CookieSummary[] {
	return cookies.map((cookie) => ({
		name: cookie.name,
		domain: cookie.domain,
		path: cookie.path,
		expires:
			cookie.session || cookie.expirationDate === undefined
				? "session"
				: new Date(cookie.expirationDate * 1000).toISOString(),
		httpOnly: cookie.httpOnly === true,
		secure: cookie.secure === true,
	}));
}

/** One line per cookie: name, where it applies, when it expires and its flags. */
export function formatCookies(cookies: readonly CookieSummary[]): string {
	if (cookies.length === 0) {
		return "No cookies for this page.";
	}
	return cookies
		.map(
			(c) =>
				`${c.name}  ${c.domain}${c.path}  expires ${c.expires}${c.httpOnly ? "  HttpOnly" : ""}${c.secure ? "  Secure" : ""}`,
		)
		.join("\n");
}
