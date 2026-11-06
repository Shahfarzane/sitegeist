/** What to offer on the welcome screen for the page the panel opened on: nothing on a plain page. */

import type { TutorialPrompt } from "./WelcomeMessage.js";

const BY_SITE: Array<{ host: RegExp; path?: RegExp; suggestions: TutorialPrompt[] }> = [
	{
		host: /(^|\.)github\.com$/,
		path: /\/pull\/\d+/,
		suggestions: [
			{ label: "Review this PR", prompt: "Review this pull request: what does it change, and what looks risky?" },
		],
	},
	{
		host: /(^|\.)github\.com$/,
		path: /\/issues\/\d+/,
		suggestions: [{ label: "Summarize this issue", prompt: "Summarize this issue and where the discussion stands." }],
	},
	{
		host: /(^|\.)github\.com$/,
		suggestions: [
			{ label: "Explain this repo", prompt: "Explain what this repository does and how it is organized." },
		],
	},
	{
		host: /^mail\.google\.com$/,
		suggestions: [
			{ label: "Summarize my inbox", prompt: "Summarize my unread emails and tell me which ones need an answer." },
			{ label: "Draft a reply", prompt: "Draft a reply to the email that is open. Do not send it." },
		],
	},
	{
		host: /^calendar\.google\.com$/,
		suggestions: [{ label: "What's on today", prompt: "What is on my calendar today, and where are the gaps?" }],
	},
	{
		host: /^docs\.google\.com$/,
		path: /\/document\//,
		suggestions: [
			{ label: "Proofread this doc", prompt: "Proofread this document and list the changes you suggest." },
		],
	},
	{
		host: /^docs\.google\.com$/,
		path: /\/spreadsheets\//,
		suggestions: [
			{ label: "Explain this sheet", prompt: "Explain what this spreadsheet contains and what stands out." },
		],
	},
	{
		host: /(^|\.)slack\.com$/,
		suggestions: [{ label: "Catch me up", prompt: "Summarize what I missed in this channel." }],
	},
	{
		host: /(^|\.)youtube\.com$/,
		path: /\/watch/,
		suggestions: [
			{ label: "Summarize this video", prompt: "Summarize this video with its key points and timestamps." },
		],
	},
	{
		host: /(^|\.)linkedin\.com$/,
		path: /\/in\//,
		suggestions: [{ label: "Summarize this profile", prompt: "Summarize this person's background in a few lines." }],
	},
	{
		host: /(^|\.)(amazon|ebay)\.[a-z.]+$/,
		suggestions: [{ label: "Compare options", prompt: "Compare the products on this page by price and reviews." }],
	},
];

/** Suggestions for a page; nothing for pages an agent cannot read. */
export function suggestionsFor(url: string | undefined, skillNames: string[] = []): TutorialPrompt[] {
	if (!url || !/^https?:/.test(url)) return [];
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return [];
	}
	const host = parsed.hostname.replace(/^www\./, "");
	const site = BY_SITE.find((s) => s.host.test(host) && (!s.path || s.path.test(parsed.pathname)));
	const fromSkills = skillNames.slice(0, 2).map((name) => ({
		label: `Use ${name}`,
		prompt: `Use the ${name} skill. What can you do for me on this page?`,
	}));
	return [...(site?.suggestions ?? []), ...fromSkills].slice(0, 4);
}
