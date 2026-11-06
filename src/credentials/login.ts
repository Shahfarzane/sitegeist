/**
 * Sign-in with 1Password, in the service worker. The values come from the native host and go
 * straight into the page: they never reach a panel, a tool result, a chat or storage. Tools get
 * back which fields were filled and nothing else.
 */

import { hostCapabilities } from "../bridge/host-capabilities.js";
import { CAPABILITY_ONEPASSWORD, type LoginChoice, type LoginValues, NATIVE_HOST_NAME } from "../bridge/protocol.js";
import { runInPage } from "../browser/page.js";

export interface FillResult {
	/** Which fields were filled. */
	filled?: string[];
	item?: string;
	/** Several logins fit this site: call again with one of these ids. */
	choose?: LoginChoice[];
}

async function askHost<T>(request: Record<string, unknown>): Promise<T> {
	if (!(await hostCapabilities()).includes(CAPABILITY_ONEPASSWORD)) {
		throw new Error("1Password needs a current sitegeist CLI on this computer. Rebuild or update it.");
	}
	const response = (await chrome.runtime.sendNativeMessage(NATIVE_HOST_NAME, request)) as
		| { result?: T; error?: string }
		| undefined;
	if (!response) throw new Error("The native host did not answer");
	if (response.error) throw new Error(response.error);
	return response.result as T;
}

/** Page-side: find the fields of a login form and set them the way frameworks expect. */
function pageFillLogin(values: { username?: string; password?: string; otp?: string }, origin: string): string[] {
	// The tab may have moved on while 1Password waited for the user: this check runs in the page,
	// right before the values go in, so a redirect cannot receive them.
	if (location.origin !== origin) throw new Error("The page changed while waiting for 1Password. Try again.");
	const visible = (el: HTMLElement) => {
		const r = el.getBoundingClientRect();
		const style = getComputedStyle(el);
		return r.width > 0 && r.height > 0 && style.visibility !== "hidden" && style.display !== "none";
	};
	const inputs = Array.from(document.querySelectorAll("input")).filter(
		(i) =>
			visible(i) &&
			!i.disabled &&
			!i.readOnly &&
			!["hidden", "checkbox", "radio", "submit", "button"].includes(i.type),
	);
	const describe = (i: HTMLInputElement) =>
		`${i.name} ${i.id} ${i.autocomplete} ${i.placeholder} ${i.getAttribute("aria-label") ?? ""}`;
	const set = (input: HTMLInputElement, value: string) => {
		input.focus();
		const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
		if (setter) setter.call(input, value);
		else input.value = value;
		input.dispatchEvent(new Event("input", { bubbles: true }));
		input.dispatchEvent(new Event("change", { bubbles: true }));
	};
	const filled: string[] = [];
	const password = inputs.find((i) => i.type === "password");
	const otp = inputs.find(
		(i) =>
			i.autocomplete === "one-time-code" ||
			/\b(otp|totp|2fa|mfa|one.?time|verification|auth.?code)\b/i.test(describe(i)),
	);
	const username =
		inputs.find((i) => i.autocomplete === "username" || i.autocomplete === "email" || i.type === "email") ??
		inputs.find((i) => /user|email|login|account|identifier/i.test(describe(i)) && i !== otp && i !== password) ??
		// A password's neighbour, or the only field of a first step, is the username.
		(password || inputs.length === 1 ? inputs.find((i) => i.type === "text" && i !== otp) : undefined);
	if (password && values.password) {
		set(password, values.password);
		filled.push("password");
	}
	if (username && values.username) {
		set(username, values.username);
		filled.unshift("username");
	}
	if (!password && otp && values.otp) {
		set(otp, values.otp);
		filled.push("otp");
	}
	return filled;
}

/** Fill the login form in a tab from 1Password. `item` picks one when several fit. */
export async function fillLogin(tabId: number, item?: string): Promise<FillResult> {
	const tab = await chrome.tabs.get(tabId);
	const url = tab.url ?? "";
	if (!/^https?:/.test(url)) throw new Error("Open the site's sign-in page first");
	let id = item;
	if (!id) {
		const choices = await askHost<LoginChoice[]>({ type: "op_search", url });
		if (choices.length === 0) throw new Error(`No 1Password login is saved for ${new URL(url).hostname}`);
		if (choices.length > 1) return { choose: choices };
		id = choices[0].id;
	}
	const login = await askHost<LoginValues>({ type: "op_read", id, url });
	const { title, ...values } = login;
	const origin = new URL(url).origin;
	const filled = await runInPage<string[]>(
		tabId,
		`(${pageFillLogin.toString()})(${JSON.stringify(values)}, ${JSON.stringify(origin)})`,
	);
	if (filled.length === 0) throw new Error("No sign-in field on this page takes what this login has");
	return { filled, item: title };
}

/** Panels ask here, so the values stay out of the panel and its chat. */
export function startLoginService(): void {
	chrome.runtime.onMessage.addListener(
		(
			message: { type?: string; tabId?: number; item?: string },
			_sender,
			respond: (reply: { result?: FillResult; error?: string }) => void,
		) => {
			if (message?.type !== "sitegeist-fill-login" || message.tabId === undefined) return;
			fillLogin(message.tabId, message.item).then(
				(result) => respond({ result }),
				(err: Error) => respond({ error: err.message }),
			);
			return true;
		},
	);
}
