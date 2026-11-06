import assert from "node:assert/strict";
import { test } from "node:test";
import { hostsMatch } from "./onepassword.ts";

test("a login matches its own site and subdomains in either direction", () => {
	assert.ok(hostsMatch("https://github.com/login", "https://github.com/session"));
	assert.ok(hostsMatch("github.com", "https://www.github.com/"));
	assert.ok(hostsMatch("google.com", "https://accounts.google.com/signin"));
	assert.ok(hostsMatch("https://login.example.com", "https://example.com/"));
});

test("look-alike hosts do not match", () => {
	assert.ok(!hostsMatch("https://github.com", "https://github.com.evil.test/"));
	assert.ok(!hostsMatch("https://github.com", "https://notgithub.com/"));
	assert.ok(!hostsMatch("https://github.com", "https://evil.test/github.com"));
	assert.ok(!hostsMatch(undefined, "https://github.com/"));
	assert.ok(!hostsMatch("not a url at all", "https://github.com/"));
});

test("an https login does not fill on plain http", () => {
	assert.ok(!hostsMatch("https://github.com/login", "http://github.com/login"));
	assert.ok(!hostsMatch("github.com", "http://github.com/login"));
	assert.ok(hostsMatch("http://127.0.0.1:3000/login", "http://127.0.0.1:3000/login"));
});
