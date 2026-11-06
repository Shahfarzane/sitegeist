// find: elements by what someone would call them.
// Run: npm test (node --import tsx --test).

import assert from "node:assert/strict";
import { test } from "node:test";
import { rankNodes } from "../src/browser/find.ts";
import type { SnapshotNode } from "../src/browser/page.ts";

function node(ref: string, role: string, name: string, extra: Partial<SnapshotNode> = {}): SnapshotNode {
	return { ref, role, name, x: 0, y: 0, width: 10, height: 10, visible: true, ...extra };
}

const page = [
	node("e1", "link", "Home", { href: "https://shop.test/" }),
	node("e2", "textbox", "Search products"),
	node("e3", "button", "Search"),
	node("e4", "button", "Sign in"),
	node("e5", "link", "Sign up"),
	node("e6", "button", "Add to cart"),
	node("e7", "link", "Basket (2)", { href: "https://shop.test/basket" }),
	node("e8", "textbox", "Email address"),
	node("e9", "textbox", "Password"),
	node("e10", "checkbox", "Remember me"),
	node("e11", "heading", "Organic mango"),
	node("e12", "button", "Continue"),
	node("e13", "button", "Menu"),
	node("e14", "link", "Terms", { visible: false }),
];

const first = (query: string) => rankNodes(page, query)[0]?.ref;

test("a role word picks the kind of element", () => {
	assert.equal(first("search bar"), "e2");
	assert.equal(first("search button"), "e3");
});

test("synonyms count", () => {
	assert.equal(first("login button"), "e4");
	assert.equal(first("log in"), "e4");
	assert.equal(first("register"), "e5");
	assert.equal(first("shopping basket"), "e7");
	assert.equal(first("view cart"), "e6");
	assert.equal(first("next button"), "e12");
	assert.equal(first("password field"), "e9");
	assert.equal(first("email input"), "e8");
});

test("plain text still works", () => {
	assert.equal(first("organic mango"), "e11");
	assert.equal(first("Add to cart"), "e6");
	assert.equal(first("remember me checkbox"), "e10");
});

test("a role alone lists that kind", () => {
	const refs = rankNodes(page, "checkbox").map((n) => n.ref);
	assert.deepEqual(refs, ["e10"]);
});

test("the subject of a one-word query is not lost as a role", () => {
	assert.equal(first("menu"), "e13");
});

test("nothing relevant finds nothing", () => {
	assert.deepEqual(rankNodes(page, "zebra"), []);
});

test("visible elements come before hidden ones", () => {
	const refs = rankNodes([node("a", "link", "Terms", { visible: false }), node("b", "link", "Terms")], "terms");
	assert.equal(refs[0].ref, "b");
});

test("the limit applies", () => {
	assert.equal(rankNodes(page, "link", 2).length, 2);
});
