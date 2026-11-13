# Privacy

Sitegeist Bridge is an unofficial fork of sitegeist. It has no server of its own, no analytics, no ads and no tracking, and the developer receives nothing from your browser.
- What you ask the assistant, and the page text, screenshots and files it reads to answer, go from your browser straight to the AI provider you connected (Anthropic, OpenAI, Google, a local Ollama, and so on), under your own key or subscription. That provider's privacy policy covers what it does with them.
- API keys, sign-in tokens, chats, skills and settings stay in the extension's storage in your browser profile. Each key or token is sent only to the service it belongs to.
- The bridge lets coding agents on your own computer (Claude Code, Codex, any MCP client) use the browser through the `sitegeist` command-line tool, over Chrome's native messaging. It takes no connections from other machines.
- MCP connectors you add receive the requests the assistant sends to them.
- `fill_login` signs in from 1Password only after you approve it in 1Password. The values go into the page, never to the AI provider.
- Pages the assistant builds run in a sandboxed page with no access to the extension, and may load open-source libraries from public CDNs (jsDelivr, unpkg, cdnjs, esm.sh).
- The model list is refreshed from models.dev, a public list of models and prices. The request carries nothing about you.
- If you turn on the optional CORS proxy, requests that need it go through the proxy address you entered.

Nothing is sold, shared for advertising, or used for anything other than the task you gave the assistant.

Questions: open an issue at https://github.com/Shahfarzane/sitegeist/issues.
