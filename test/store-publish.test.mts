import assert from "node:assert/strict";
import { createVerify, generateKeyPairSync } from "node:crypto";
import { test } from "node:test";
// @ts-expect-error: a plain .mjs script without type declarations
import { fetchStatus, ITEM_ID, PUBLISHER_ID, publish, SCOPE, signedAssertion } from "../scripts/store-publish.mjs";

// A throwaway key in the shape of a Google service account JSON key. No request leaves the test.
const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
const key = {
	client_email: "cws-publisher@example.iam.gserviceaccount.com",
	private_key_id: "kid-1",
	private_key: pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
	token_uri: "https://oauth2.googleapis.com/token",
};

type Call = { url: string; method: string; headers: Record<string, string>; body: unknown };
const fakeStore = (replies: Record<string, unknown>[]) => {
	const calls: Call[] = [];
	const fetchImpl = async (url: string, init: { method: string; headers: Record<string, string>; body?: unknown }) => {
		calls.push({ url, method: init.method, headers: init.headers, body: init.body });
		const reply = replies.shift();
		if (!reply) throw new Error(`unexpected request ${init.method} ${url}`);
		return new Response(JSON.stringify(reply), { status: 200 });
	};
	return { calls, fetchImpl };
};

const item = `https://chromewebstore.googleapis.com/v2/publishers/${PUBLISHER_ID}/items/${ITEM_ID}`;

test("the assertion is a JWT the service account's key signs, for the Web Store scope", () => {
	const [header, claims, signature] = signedAssertion(key, 1_000).split(".");
	assert.deepEqual(JSON.parse(Buffer.from(header, "base64url").toString()), { alg: "RS256", typ: "JWT", kid: "kid-1" });
	assert.deepEqual(JSON.parse(Buffer.from(claims, "base64url").toString()), {
		iss: key.client_email,
		scope: SCOPE,
		aud: key.token_uri,
		iat: 1_000,
		exp: 4_600,
	});
	const ok = createVerify("RSA-SHA256").update(`${header}.${claims}`).verify(pair.publicKey, signature, "base64url");
	assert.equal(ok, true);
});

test("status exchanges the assertion for a token, then reads the item's status", async () => {
	const { calls, fetchImpl } = fakeStore([{ access_token: "t1" }, { itemId: ITEM_ID, lastAsyncUploadState: "SUCCEEDED" }]);
	const status = await fetchStatus({ key, fetchImpl });
	assert.equal(status.itemId, ITEM_ID);
	assert.equal(calls[0].url, key.token_uri);
	assert.match(String(calls[0].body), /grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer/);
	assert.deepEqual([calls[1].method, calls[1].url], ["GET", `${item}:fetchStatus`]);
	assert.equal(calls[1].headers.Authorization, "Bearer t1");
});

test("publish uploads the zip, waits out an asynchronous upload, then submits", async () => {
	const zip = new Uint8Array([80, 75, 3, 4]);
	const { calls, fetchImpl } = fakeStore([
		{ access_token: "t1" },
		{ uploadState: "IN_PROGRESS" },
		{ lastAsyncUploadState: "SUCCEEDED" },
		{ state: "PENDING_REVIEW", itemId: ITEM_ID },
	]);
	const result = await publish({ key, zip, fetchImpl, wait: async () => {} });
	assert.equal(result.state, "PENDING_REVIEW");
	assert.deepEqual(
		calls.slice(1).map((c) => `${c.method} ${c.url}`),
		[
			`POST https://chromewebstore.googleapis.com/upload/v2/publishers/${PUBLISHER_ID}/items/${ITEM_ID}:upload`,
			`GET ${item}:fetchStatus`,
			`POST ${item}:publish`,
		],
	);
	assert.equal(calls[1].body, zip);
	assert.equal(calls[1].headers["Content-Type"], "application/zip");
	assert.equal(calls[3].body, "{}");
});

test("publish stops before submitting when the store rejects the upload", async () => {
	const { calls, fetchImpl } = fakeStore([{ access_token: "t1" }, { uploadState: "FAILED" }]);
	await assert.rejects(publish({ key, zip: new Uint8Array([1]), fetchImpl, wait: async () => {} }), /upload ended FAILED/);
	assert.equal(calls.length, 2);
});
