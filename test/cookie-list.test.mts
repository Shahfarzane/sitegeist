// cookies action: names, domains and expiry, never a value.
// Run: npm test (node --import tsx --test).

import assert from "node:assert/strict";
import { test } from "node:test";
import { formatCookies, summarizeCookies } from "../src/tools/cookie-list.ts";

const fromChrome = [
	{
		name: "session_token",
		value: "s3cret-value-that-must-not-leave",
		domain: ".loom.com",
		path: "/",
		session: false,
		expirationDate: 1794500000,
		httpOnly: true,
		secure: true,
	},
	{ name: "theme", value: "dark", domain: "www.loom.com", path: "/app", session: true, httpOnly: false, secure: false },
];

test("a cookie's value appears in neither the text nor the details", () => {
	const summary = summarizeCookies(fromChrome);
	const text = formatCookies(summary);
	for (const value of ["s3cret-value-that-must-not-leave", "dark"]) {
		assert.ok(!text.includes(value), text);
		assert.ok(!JSON.stringify(summary).includes(value));
	}
	for (const entry of summary) {
		assert.ok(!("value" in entry));
	}
});

test("names, domains, paths, expiry and flags are kept", () => {
	const [token, theme] = summarizeCookies(fromChrome);
	assert.deepEqual(token, {
		name: "session_token",
		domain: ".loom.com",
		path: "/",
		expires: "2026-11-12T16:13:20.000Z",
		httpOnly: true,
		secure: true,
	});
	assert.equal(theme.expires, "session");
	assert.equal(
		formatCookies([token, theme]),
		"session_token  .loom.com/  expires 2026-11-12T16:13:20.000Z  HttpOnly  Secure\ntheme  www.loom.com/app  expires session",
	);
});

test("a page without cookies says so", () => {
	assert.equal(formatCookies(summarizeCookies([])), "No cookies for this page.");
});
