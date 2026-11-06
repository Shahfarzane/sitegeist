/** fill_login for the panel agent: sign in with 1Password without seeing the password. */

import type { AgentTool } from "@mariozechner/pi-agent-core";
import { type Static, Type } from "@sinclair/typebox";
import { getCurrentBrowserSession } from "../browser/current.js";
import type { FillResult } from "../credentials/login.js";

const schema = Type.Object({
	item: Type.Optional(Type.String({ description: "Id of a login, when an earlier call listed several" })),
});

export function createFillLoginTool(): AgentTool<typeof schema, FillResult> {
	return {
		name: "fill_login",
		label: "Sign in with 1Password",
		description:
			"Fill the sign-in form on the current page from the user's 1Password. They approve it in 1Password; you never see the password. Works per step: on a page with only a username field it fills that, on a one-time-code page it fills the code. Afterwards press the sign-in button yourself. Use this instead of asking the user for a password or typing one.",
		parameters: schema,
		execute: async (_toolCallId, args: Static<typeof schema>) => {
			const tab = await getCurrentBrowserSession().requireCurrentTab();
			const reply = (await chrome.runtime.sendMessage({
				type: "sitegeist-fill-login",
				tabId: tab.id,
				item: args.item,
			})) as { result?: FillResult; error?: string } | undefined;
			if (!reply) throw new Error("The extension's service worker did not answer");
			if (reply.error) throw new Error(reply.error);
			const result = reply.result ?? {};
			const text = result.choose
				? `Several logins fit this site. Call fill_login with one id:\n${result.choose.map((c) => `${c.id}: ${c.title}${c.username ? ` (${c.username})` : ""}`).join("\n")}`
				: `Filled ${result.filled?.join(" and ")} from ${result.item}.`;
			return { content: [{ type: "text", text }], details: result };
		},
	};
}
