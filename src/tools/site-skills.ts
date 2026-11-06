/**
 * Built-in knowledge of the sites people use most. URL recipes come first: they outlast any
 * markup change. The helpers read what the page shows; acting (sending, posting) stays a separate,
 * deliberate step for the agent.
 */

import type { Skill } from "../storage/stores/skills-store.js";

const stamp = "2026-11-06T00:00:00.000Z";

const github: Skill = {
	name: "github",
	domainPatterns: ["github.com"],
	shortDescription: "Read repositories, issues and pull requests on GitHub, with URL recipes for everything else",
	description: `# GitHub

Prefer URLs to clicking; they are stable and each is one navigate.

- Open pull requests: \`/<owner>/<repo>/pulls\`, issues: \`/<owner>/<repo>/issues\`
- Filter: \`/pulls?q=is:open+author:<user>\`, \`/issues?q=is:open+label:bug\`
- A pull request's diff: \`/<owner>/<repo>/pull/<n>/files\`, as plain text: \`/<owner>/<repo>/pull/<n>.diff\`
- A file: \`/<owner>/<repo>/blob/<branch>/<path>\`, raw: \`https://raw.githubusercontent.com/<owner>/<repo>/<branch>/<path>\`
- New issue: \`/<owner>/<repo>/issues/new?title=...&body=...\`
- Code search: \`/search?q=<text>+repo:<owner>/<repo>&type=code\`
- Keyboard: \`t\` file finder, \`/\` search, \`.\` opens the web editor.

\`window.gh\` is available in browserjs on github.com.`,
	createdAt: stamp,
	lastUpdated: stamp,
	examples: `const info = await browserjs(() => window.gh.page());
const thread = await browserjs(() => window.gh.readThread());
const files = await browserjs(() => window.gh.files());`,
	library: `window.gh = {
  page() {
    const m = location.pathname.match(/^\\/([^/]+)\\/([^/]+)(?:\\/(pull|issues|blob|tree|commit|actions)(?:\\/([^/]+))?)?/);
    return m ? { owner: m[1], repo: m[2], kind: m[3] || "repo", id: m[4] || null } : { kind: "other" };
  },
  readThread() {
    const titles = document.querySelectorAll('[data-testid="issue-title"], .js-issue-title, h1 bdi, h1');
    const shown = [...titles].map((el) => el.innerText.trim().split("\\n")[0]).find(Boolean);
    const title = shown || document.title.split(" · ")[0].replace(/ by [^ ]+$/, "");
    const bodies = [...document.querySelectorAll('.markdown-body, [data-testid="markdown-body"]')].filter(
      (body) => !body.parentElement.closest('.markdown-body, [data-testid="markdown-body"]'),
    );
    const comments = bodies
      .map((body) => {
        const box = body.closest('[data-testid="comment-viewer-outer-box"], .timeline-comment, .js-comment-container, [data-testid="issue-viewer-issue-container"]');
        const author = box && box.querySelector('a[data-testid="avatar-link"], a.author, [data-testid="issue-body-header-author"]');
        return { author: author ? (author.getAttribute("aria-label") || author.innerText || "").trim() : "", text: body.innerText.trim() };
      })
      .filter((comment) => comment.text);
    return { title, comments };
  },
  files() {
    const names = document.querySelectorAll('[data-testid="diff-file-header"] code, .file-header [data-path], [data-file-path]');
    return [...new Set([...names].map((el) => el.getAttribute("data-path") || el.getAttribute("data-file-path") || el.innerText.trim()))].filter(Boolean);
  },
};
`,
};

const gmail: Skill = {
	name: "gmail",
	domainPatterns: ["mail.google.com"],
	shortDescription: "Read and search Gmail, open threads, and start drafts from a URL",
	description: `# Gmail

Gmail navigates by URL hash; each of these is one navigate.

- Inbox: \`https://mail.google.com/mail/u/0/#inbox\`
- Unread: \`#search/is%3Aunread\`, any search: \`#search/<url-encoded query>\` (\`from:\`, \`subject:\`, \`has:attachment\`, \`newer_than:7d\`)
- A label: \`#label/<name>\`, sent: \`#sent\`, drafts: \`#drafts\`
- New draft with the fields filled: \`https://mail.google.com/mail/u/0/?view=cm&fs=1&to=<to>&su=<subject>&body=<body>\`

\`/u/0/\` is the first signed-in account, \`/u/1/\` the second.

\`window.gmail\` is available in browserjs. \`listThreads()\` reads the list on screen, \`openThread(index)\` opens one, \`readThread()\` reads the open thread, including every message that is expanded.

A draft is not an email: sending is a separate step, so leave it as a draft unless the user asked you to send.`,
	createdAt: stamp,
	lastUpdated: stamp,
	examples: `await navigate({ url: "https://mail.google.com/mail/u/0/#search/is%3Aunread" });
const threads = await browserjs(() => window.gmail.listThreads(20));
await browserjs(() => window.gmail.openThread(0));
const thread = await browserjs(() => window.gmail.readThread());`,
	library: `window.gmail = {
  rows() {
    return [...document.querySelectorAll("tr.zA")].filter((row) => row.getBoundingClientRect().height > 0);
  },
  listThreads(limit = 25) {
    return this.rows().slice(0, limit).map((row, index) => {
      const sender = row.querySelector(".yP, .zF");
      const date = row.querySelector("td.xW span");
      return {
        index,
        unread: row.classList.contains("zE"),
        from: sender ? sender.getAttribute("name") || sender.innerText : "",
        email: sender ? sender.getAttribute("email") : null,
        subject: (row.querySelector(".bog") || {}).innerText || "",
        snippet: ((row.querySelector(".y2") || {}).innerText || "").replace(/^\\s*-\\s*/, ""),
        date: date ? date.getAttribute("title") || date.innerText : "",
      };
    });
  },
  openThread(index) {
    const row = this.rows()[index];
    if (!row) throw new Error("No thread at index " + index);
    row.click();
    return true;
  },
  readThread() {
    const subject = (document.querySelector("h2.hP") || {}).innerText || "";
    const messages = [...document.querySelectorAll("div.adn")].map((message) => {
      const from = message.querySelector(".gD");
      const date = message.querySelector(".g3");
      const body = message.querySelector(".a3s");
      return {
        from: from ? from.getAttribute("name") : "",
        email: from ? from.getAttribute("email") : null,
        date: date ? date.getAttribute("title") || date.innerText : "",
        text: body ? body.innerText.trim() : "",
      };
    });
    return { subject, messages };
  },
};
`,
};

const googleDocs: Skill = {
	name: "google-docs",
	domainPatterns: ["docs.google.com/document/**"],
	shortDescription: "Read and edit Google Docs, which draw on a canvas instead of the DOM",
	description: `# Google Docs

The editor draws on a canvas, so the DOM does not contain the document text.

**Reading:** navigate to the document's plain view, \`https://docs.google.com/document/d/<id>/mobilebasic\`, and read \`document.body.innerText\`. Then navigate back to \`/edit\`. \`window.gdoc.readUrl()\` gives that URL.

**Writing:** click into the document with a native click, then use native typing; the document takes real key events. Keep the shortcuts in mind: Cmd/Ctrl+End jumps to the end, Cmd/Ctrl+A selects all, Cmd/Ctrl+Alt+M adds a comment, Cmd/Ctrl+Alt+1 to 6 apply headings.

**New document:** https://docs.new`,
	createdAt: stamp,
	lastUpdated: stamp,
	examples: `const url = await browserjs(() => window.gdoc.readUrl());
await navigate({ url });
const text = await browserjs(() => document.body.innerText);`,
	library: `window.gdoc = {
  id() {
    const m = location.pathname.match(/\\/document\\/(?:u\\/\\d+\\/)?d\\/([^/]+)/);
    return m ? m[1] : null;
  },
  title() {
    const input = document.querySelector(".docs-title-input");
    return input ? input.value : document.title.replace(/ - Google Docs$/, "");
  },
  readUrl() {
    const id = this.id();
    if (!id) throw new Error("Open a document first");
    return "https://docs.google.com/document/d/" + id + "/mobilebasic";
  },
};
`,
};

const slack: Skill = {
	name: "slack",
	domainPatterns: ["app.slack.com", "*.slack.com"],
	shortDescription: "Read Slack channels and write message drafts in the web client",
	description: `# Slack

Use the web client at \`https://app.slack.com/client/<team>/<channel>\`. Cmd/Ctrl+K opens the quick switcher: type a channel or person, press Enter. It beats hunting through the sidebar.

\`window.slack\` is available in browserjs. \`channel()\` names the open channel, \`messages(limit)\` reads what is loaded, \`channels()\` lists the sidebar, \`draft(text)\` types into the message box without sending.

The message list is virtualized: only messages near the view exist in the DOM, so scroll up and read again for older ones.

A draft is not a message: pressing Enter sends it, so only do that when the user asked you to send.`,
	createdAt: stamp,
	lastUpdated: stamp,
	examples: `const channel = await browserjs(() => window.slack.channel());
const messages = await browserjs(() => window.slack.messages(30));
await browserjs(() => window.slack.draft("Thanks, on it."));`,
	library: `window.slack = {
  channel() {
    const el = document.querySelector('[data-qa="channel_name"], .p-view_header__channel_title, [data-qa="channel_header_title"]');
    return el ? el.innerText.trim() : null;
  },
  channels() {
    const items = document.querySelectorAll('[data-qa^="channel_sidebar_name"], .p-channel_sidebar__name');
    return [...new Set([...items].map((el) => el.innerText.trim()).filter(Boolean))];
  },
  messages(limit = 50) {
    const rows = document.querySelectorAll('[data-qa="message_container"], .c-message_kit__background');
    let author = "";
    const out = [];
    for (const row of rows) {
      const sender = row.querySelector('[data-qa="message_sender_name"], .c-message__sender_button');
      if (sender) author = sender.innerText.trim();
      const text = row.querySelector('[data-qa="message-text"], .c-message_kit__blocks, .p-rich_text_section');
      const time = row.querySelector("a.c-timestamp, .c-timestamp");
      if (text) out.push({ author, time: time ? time.getAttribute("aria-label") || time.innerText : "", text: text.innerText.trim() });
    }
    return out.slice(-limit);
  },
  draft(text) {
    const box = document.querySelector('[data-qa="message_input"] .ql-editor, .ql-editor[contenteditable="true"]');
    if (!box) throw new Error("No message box on this page");
    box.focus();
    document.execCommand("insertText", false, text);
    return true;
  },
};
`,
};

export const siteSkills: Skill[] = [github, gmail, googleDocs, slack];
