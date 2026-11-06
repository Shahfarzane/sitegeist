/**
 * Finds elements by what someone would call them: "search bar", "login button", "add to cart".
 * The words of a query rarely match an element's label exactly, so the words are read for what
 * they ask: role words say what kind of element, the rest what it is about, and common synonyms
 * count as matches ("log in" finds "Sign in").
 */

import type { SnapshotNode } from "./page.js";

const STOP_WORDS = new Set([
	"the",
	"a",
	"an",
	"for",
	"to",
	"of",
	"on",
	"in",
	"at",
	"with",
	"that",
	"this",
	"my",
	"and",
]);

const ROLE_WORDS: Record<string, string[]> = {
	button: ["button", "generic"],
	btn: ["button", "generic"],
	link: ["link"],
	anchor: ["link"],
	input: ["textbox", "searchbox", "combobox"],
	field: ["textbox", "searchbox", "combobox"],
	box: ["textbox", "searchbox", "combobox", "checkbox"],
	bar: ["textbox", "searchbox", "combobox"],
	textbox: ["textbox", "searchbox"],
	textarea: ["textbox"],
	checkbox: ["checkbox", "switch"],
	toggle: ["checkbox", "switch"],
	switch: ["switch", "checkbox"],
	radio: ["radio"],
	dropdown: ["combobox", "menuitem", "button"],
	select: ["combobox"],
	menu: ["menuitem", "button", "link"],
	tab: ["tab"],
	heading: ["heading"],
	title: ["heading"],
	option: ["option", "radio"],
};

const SYNONYMS = [
	["login", "log in", "signin", "sign in", "logon"],
	["logout", "log out", "signout", "sign out"],
	["signup", "sign up", "register", "create account", "join"],
	["search", "find", "query", "lookup"],
	["cart", "basket", "bag", "checkout"],
	["close", "dismiss", "cancel"],
	["menu", "navigation", "nav", "hamburger"],
	["submit", "send", "confirm", "continue", "next", "ok", "done", "apply"],
	["save", "update", "store"],
	["delete", "remove", "trash", "discard"],
	["settings", "preferences", "options", "config"],
	["email", "e-mail", "mail"],
	["password", "passcode", "pass"],
	["username", "user name", "user", "login name"],
	["profile", "account", "avatar"],
	["back", "previous", "prev", "return"],
	["add", "new", "create", "plus"],
	["download", "export", "save as"],
	["upload", "attach", "import", "browse"],
	["help", "support", "faq"],
];

const MULTI_WORD = SYNONYMS.flat().filter((term) => term.includes(" "));

function synonymsOf(word: string): string[] {
	return SYNONYMS.filter((group) => group.includes(word)).flat();
}

function scoreNode(node: SnapshotNode, words: string[], wantedRoles: Set<string>, phrase: string): number {
	const name = node.name.toLowerCase();
	const hay = `${name} ${(node.value ?? "").toLowerCase()} ${(node.href ?? "").toLowerCase()}`;
	const nameWords = new Set(name.split(/[^\p{L}\p{N}]+/u));
	let score = 0;
	let matched = 0;
	for (const word of words) {
		if (nameWords.has(word)) score += 8;
		else if (name.includes(word)) score += 5;
		else if (hay.includes(word)) score += 3;
		else if (synonymsOf(word).some((s) => hay.includes(s))) score += 6;
		else continue;
		matched++;
	}
	// With content words in the query, a role word alone must not surface every button.
	if (words.length > 0 && matched === 0) return 0;
	if (matched > 0 && matched < words.length) score -= (words.length - matched) * 2;
	if (phrase && name === phrase) score += 30;
	else if (phrase && name.includes(phrase)) score += 10;
	if (wantedRoles.size > 0) {
		if (wantedRoles.has(node.role)) score += 6;
		else if (words.length === 0) return 0;
	}
	if (node.visible) score += 1;
	return Math.max(0, score);
}

/** The nodes that fit `query`, best first. */
export function rankNodes(nodes: SnapshotNode[], query: string, limit = 20): SnapshotNode[] {
	const phrase = query.trim().toLowerCase();
	const wantedRoles = new Set<string>();
	const words: string[] = [];
	// Two-word synonyms stay whole: "log in" must not lose "in" as a stop word.
	const joined = MULTI_WORD.reduce((text, term) => text.replaceAll(term, term.replace(" ", "\u0000")), phrase);
	for (const raw of joined.split(/\s+/)) {
		const token = raw.replace("\u0000", " ");
		if (!token || STOP_WORDS.has(token)) continue;
		const roles = ROLE_WORDS[token];
		if (roles) for (const role of roles) wantedRoles.add(role);
		else words.push(token);
	}
	return nodes
		.map((node, index) => ({ node, index, score: scoreNode(node, words, wantedRoles, phrase) }))
		.filter((scored) => scored.score > 0)
		.sort((a, b) => b.score - a.score || a.index - b.index)
		.slice(0, limit)
		.map((scored) => scored.node);
}
