// Welcome suggestions follow the page.
// Run: npm test (node --import tsx --test).

import assert from "node:assert/strict";
import { test } from "node:test";
import { suggestionsFor } from "../src/messages/suggestions.ts";

const labels = (url?: string, skills?: string[]) => suggestionsFor(url, skills).map((s) => s.label);

test("a known page gets its own suggestions first", () => {
	assert.equal(labels("https://github.com/a/b/pull/12")[0], "Review this PR");
	assert.equal(labels("https://github.com/a/b/issues/3")[0], "Summarize this issue");
	assert.equal(labels("https://github.com/a/b")[0], "Explain this repo");
	assert.equal(labels("https://mail.google.com/mail/u/0/#inbox")[0], "Summarize my inbox");
	assert.equal(labels("https://docs.google.com/document/d/x/edit")[0], "Proofread this doc");
	assert.equal(labels("https://www.youtube.com/watch?v=1")[0], "Summarize this video");
	assert.equal(labels("https://acme.slack.com/archives/C1")[0], "Catch me up");
});

test("any readable page can be summarized", () => {
	assert.deepEqual(labels("https://example.com/"), ["Summarize this page"]);
});

test("skills for the site are offered", () => {
	assert.deepEqual(labels("https://example.com/", ["shop-search"]), ["Use shop-search", "Summarize this page"]);
});

test("the list stays short", () => {
	assert.equal(labels("https://mail.google.com/", ["a", "b", "c"]).length, 4);
});

test("pages an agent cannot read get nothing", () => {
	assert.deepEqual(labels("chrome://newtab/"), []);
	assert.deepEqual(labels(undefined), []);
	assert.deepEqual(labels("not a url"), []);
});
