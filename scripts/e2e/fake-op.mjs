#!/usr/bin/env node
// Stands in for the 1Password CLI: the e2e suite never runs the real one.
const port = process.env.SITEGEIST_E2E_LOGIN_PORT;
const site = `http://127.0.0.1:${port}/login`;
const items = {
	one: { id: "one", title: "Fixture login", urls: [{ href: site }], additional_information: "ada@example.test" },
	other: { id: "other", title: "Somewhere else", urls: [{ href: "https://other.example" }] },
	two: { id: "two", title: "Second login", urls: [{ href: site }], additional_information: "bob@example.test" },
	// Answers late, as when the user takes a moment with Touch ID.
	slow: { id: "slow", title: "Slow approval", urls: [{ href: `http://127.0.0.1:${port}/redirecting` }] },
};
const args = process.argv.slice(2);
if (args[0] === "item" && args[1] === "list") {
	const extra = process.env.SITEGEIST_E2E_SECOND_LOGIN ? [items.two] : [];
	process.stdout.write(JSON.stringify([items.one, items.other, ...extra]));
} else if (args[0] === "item" && args[1] === "get") {
	const item = items[args[2]];
	if (!item) {
		process.stderr.write("[ERROR] item not found\n");
		process.exit(1);
	}
	if (item.id === "slow") await new Promise((r) => setTimeout(r, 1500));
	process.stdout.write(
		JSON.stringify({
			...item,
			fields: [
				{ id: "username", type: "STRING", purpose: "USERNAME", value: "ada@example.test" },
				{ id: "password", type: "CONCEALED", purpose: "PASSWORD", value: "s3cret-test-value" },
				{ id: "one-time", type: "OTP", value: "otpauth://x", totp: "424242" },
			],
		}),
	);
} else {
	process.stderr.write("unexpected op call\n");
	process.exit(1);
}
