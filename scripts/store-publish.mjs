// Chrome Web Store API (v2) client for the fork's store item, with no dependencies.
//
//   node scripts/store-publish.mjs status         the item's live and submitted revisions
//   node scripts/store-publish.mjs publish <zip>  upload the zip, then submit it for review
//
// CWS_SERVICE_ACCOUNT_KEY is the path of the service account's JSON key (store-publish.sh
// reads it from 1Password DEV with op-agents into a temp file). The account is linked to the
// publisher in the developer dashboard (Settings > Service account) and has no Cloud roles.
// A submitted version goes live by itself after review, with the visibility the dashboard
// sets (Unlisted).

import { createSign } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const PUBLISHER_ID = "57872b7a-1854-48c2-86fa-ed92000fc7c7";
export const ITEM_ID = "lnncppjiohlpejgcbdgoihplimdckddn";
export const SCOPE = "https://www.googleapis.com/auth/chromewebstore";
const API = "https://chromewebstore.googleapis.com";
const TOKEN_URI = "https://oauth2.googleapis.com/token";

export const itemUrl = (action, { upload = false } = {}) =>
	`${API}${upload ? "/upload" : ""}/v2/publishers/${PUBLISHER_ID}/items/${ITEM_ID}:${action}`;

// A service account signs its own OAuth assertion (RFC 7523): RS256 over header.claims.
export const signedAssertion = (key, now = Math.floor(Date.now() / 1000)) => {
	const part = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
	const unsigned = `${part({ alg: "RS256", typ: "JWT", kid: key.private_key_id })}.${part({
		iss: key.client_email,
		scope: SCOPE,
		aud: key.token_uri ?? TOKEN_URI,
		iat: now,
		exp: now + 3600,
	})}`;
	const signature = createSign("RSA-SHA256").update(unsigned).sign(key.private_key).toString("base64url");
	return `${unsigned}.${signature}`;
};

const failure = async (what, response) =>
	new Error(`${what}: HTTP ${response.status} ${(await response.text()).slice(0, 500)}`);

export const accessToken = async (key, fetchImpl = fetch) => {
	const response = await fetchImpl(key.token_uri ?? TOKEN_URI, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
			assertion: signedAssertion(key),
		}),
	});
	if (!response.ok) throw await failure("token", response);
	return (await response.json()).access_token;
};

const api = async (fetchImpl, token, method, url, body) => {
	const response = await fetchImpl(url, {
		method,
		headers: {
			Authorization: `Bearer ${token}`,
			...(body instanceof Uint8Array ? { "Content-Type": "application/zip" } : {}),
			...(body && !(body instanceof Uint8Array) ? { "Content-Type": "application/json" } : {}),
		},
		body: body instanceof Uint8Array ? body : body ? JSON.stringify(body) : undefined,
	});
	if (!response.ok) throw await failure(`${method} ${url}`, response);
	return response.json();
};

export const fetchStatus = async ({ key, fetchImpl = fetch }) =>
	api(fetchImpl, await accessToken(key, fetchImpl), "GET", itemUrl("fetchStatus"));

// Upload, wait for an asynchronous upload to finish, then submit. Returns the publish response
// ({ state: "PENDING_REVIEW", ... }). An upload the store rejects stops before submitting.
export const publish = async ({
	key,
	zip,
	fetchImpl = fetch,
	wait = (ms) => new Promise((r) => setTimeout(r, ms)),
}) => {
	const token = await accessToken(key, fetchImpl);
	const upload = await api(fetchImpl, token, "POST", itemUrl("upload", { upload: true }), zip);
	let state = upload.uploadState;
	for (let attempt = 0; state === "IN_PROGRESS" && attempt < 30; attempt++) {
		await wait(10_000);
		state = (await api(fetchImpl, token, "GET", itemUrl("fetchStatus"))).lastAsyncUploadState;
	}
	if (state !== "SUCCEEDED") throw new Error(`upload ended ${state}: ${JSON.stringify(upload)}`);
	return api(fetchImpl, token, "POST", itemUrl("publish"), {});
};

const summary = (status) => ({
	item: status.itemId,
	published: status.publishedItemRevisionStatus ?? null,
	submitted: status.submittedItemRevisionStatus ?? null,
	lastUpload: status.lastAsyncUploadState ?? null,
	takenDown: status.takenDown ?? false,
	warned: status.warned ?? false,
});

const main = async () => {
	const [command, zipPath] = process.argv.slice(2);
	const keyPath = process.env.CWS_SERVICE_ACCOUNT_KEY;
	if (!["status", "publish"].includes(command) || (command === "publish" && !zipPath)) {
		console.error("usage: store-publish.mjs status | publish <zip>   (CWS_SERVICE_ACCOUNT_KEY=<key.json>)");
		process.exit(2);
	}
	if (!keyPath) throw new Error("CWS_SERVICE_ACCOUNT_KEY is not set");
	const key = JSON.parse(readFileSync(keyPath, "utf8"));
	const result =
		command === "status"
			? summary(await fetchStatus({ key }))
			: await publish({ key, zip: new Uint8Array(readFileSync(zipPath)) });
	console.log(JSON.stringify(result, null, 2));
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	main().catch((error) => {
		console.error(`store-publish.mjs: ${error.message}`);
		process.exitCode = 1;
	});
}
