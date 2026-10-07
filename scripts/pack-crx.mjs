// Package dist-chrome/ for private distribution:
//   release/sitegeist-<version>.zip  unpacked build (Load unpacked, or a Web Store upload)
//   release/sitegeist-<version>.crx  CRX3 signed with the given RSA key
//   release/updates.xml              update manifest for self-hosting (with --codebase)
//   release/sitegeist-chrome-policy.mobileconfig
//                                    macOS profile that allowlists the extension id in Chrome
//
// Usage:
//   node scripts/pack-crx.mjs --key <private-key.pem> [--codebase <base-url>] [--no-crx]
//   CRX_PRIVATE_KEY="$(cat key.pem)" node scripts/pack-crx.mjs ...
//
// The extension id is derived from the signing key. The key must match the `key` in the
// manifest, otherwise the release would install under a different id than unpacked builds
// and the bridge's native messaging manifest (cli/src/install.ts) expect.
// --codebase is the URL the .crx and updates.xml are served from (http, https or file),
// minus the file name; it also becomes the packaged manifest's `update_url`.
//
// Google Chrome on macOS and Windows disables off-store extensions unless enterprise policy
// allows their id. ExtensionInstallAllowlist is honored from a profile the user installs
// (no MDM needed); ExtensionInstallForcelist with an off-store URL is not.
//
// CRX3 layout (components/crx_file/crx3.proto in Chromium):
//   "Cr24" | u32le 3 | u32le header size | CrxFileHeader | zip
//   CrxFileHeader { 2: AsymmetricKeyProof { 1: public key, 2: signature }, 10000: SignedData { 1: crx id } }
//   signature = RSA-SHA256 over "CRX3 SignedData\0" | u32le len(SignedData) | SignedData | zip

import { createHash, createPrivateKey, createPublicKey, createSign } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import JSZip from "jszip";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

const { values: args } = parseArgs({
	options: {
		key: { type: "string" },
		dir: { type: "string", default: join(packageRoot, "dist-chrome") },
		out: { type: "string", default: join(packageRoot, "release") },
		codebase: { type: "string" },
		"no-crx": { type: "boolean", default: false },
	},
});

const varint = (value) => {
	const bytes = [];
	let n = value;
	while (n > 0x7f) {
		bytes.push((n & 0x7f) | 0x80);
		n >>>= 7;
	}
	bytes.push(n);
	return Buffer.from(bytes);
};

// Protobuf length-delimited field (wire type 2).
const field = (number, bytes) => Buffer.concat([varint((number << 3) | 2), varint(bytes.length), bytes]);

const u32le = (n) => {
	const buf = Buffer.alloc(4);
	buf.writeUInt32LE(n);
	return buf;
};

// Chrome ids are the first 16 bytes of sha256(SPKI public key), hex digits mapped 0-f -> a-p.
const extensionIdFor = (crxId) =>
	[...crxId.toString("hex")].map((c) => String.fromCharCode(97 + Number.parseInt(c, 16))).join("");

const listFiles = (dir) =>
	readdirSync(dir).flatMap((name) => {
		const path = join(dir, name);
		return statSync(path).isDirectory() ? listFiles(path) : [path];
	});

const loadKey = () => {
	const pem = args.key ? readFileSync(args.key, "utf8") : process.env.CRX_PRIVATE_KEY;
	if (!pem) return undefined;
	const privateKey = createPrivateKey(pem);
	if (privateKey.asymmetricKeyType !== "rsa") throw new Error("CRX signing key must be RSA");
	const publicKeyDer = createPublicKey(privateKey).export({ type: "spki", format: "der" });
	const crxId = createHash("sha256").update(publicKeyDer).digest().subarray(0, 16);
	return { privateKey, publicKeyDer, crxId, id: extensionIdFor(crxId) };
};

const buildZip = async (manifest) => {
	const zip = new JSZip();
	// Fixed timestamps keep the archive byte-identical for identical input.
	const date = new Date("2000-01-01T00:00:00Z");
	for (const path of listFiles(args.dir).sort()) {
		const name = relative(args.dir, path).split("\\").join("/");
		if (name.endsWith(".map") || name === ".DS_Store") continue;
		const content = name === "manifest.json" ? `${JSON.stringify(manifest, null, "\t")}\n` : readFileSync(path);
		zip.file(name, content, { date });
	}
	return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 9 } });
};

const buildCrx = (zip, key) => {
	const signedHeaderData = field(1, key.crxId);
	const signer = createSign("sha256");
	signer.update(Buffer.from("CRX3 SignedData\x00", "latin1"));
	signer.update(u32le(signedHeaderData.length));
	signer.update(signedHeaderData);
	signer.update(zip);
	const signature = signer.sign(key.privateKey);
	const proof = Buffer.concat([field(1, key.publicKeyDer), field(2, signature)]);
	const header = Buffer.concat([field(2, proof), field(10000, signedHeaderData)]);
	return Buffer.concat([Buffer.from("Cr24", "latin1"), u32le(3), u32le(header.length), header, zip]);
};

// Deterministic UUIDs keep the profile identity stable, so reinstalling it replaces the old one.
const uuidFor = (seed) => {
	const hex = createHash("sha256").update(seed).digest("hex").toUpperCase();
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
};

const policyProfile = (id, codebase) => {
	const sources = codebase
		? `
			<key>ExtensionInstallSources</key>
			<array>
				<string>${codebase}/*</string>
			</array>`
		: "";
	return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>PayloadContent</key>
	<array>
		<dict>
			<key>PayloadDisplayName</key>
			<string>Google Chrome</string>
			<key>PayloadIdentifier</key>
			<string>sitegeist.chrome-extension.${id}.chrome</string>
			<key>PayloadType</key>
			<string>com.google.Chrome</string>
			<key>PayloadUUID</key>
			<string>${uuidFor(`${id}/chrome`)}</string>
			<key>PayloadVersion</key>
			<integer>1</integer>
			<key>ExtensionInstallAllowlist</key>
			<array>
				<string>${id}</string>
			</array>${sources}
		</dict>
	</array>
	<key>PayloadDescription</key>
	<string>Lets Google Chrome keep the self-signed sitegeist extension (${id}) enabled. Installs and blocks nothing else.</string>
	<key>PayloadDisplayName</key>
	<string>sitegeist Chrome extension</string>
	<key>PayloadIdentifier</key>
	<string>sitegeist.chrome-extension.${id}</string>
	<key>PayloadScope</key>
	<string>User</string>
	<key>PayloadType</key>
	<string>Configuration</string>
	<key>PayloadUUID</key>
	<string>${uuidFor(id)}</string>
	<key>PayloadVersion</key>
	<integer>1</integer>
</dict>
</plist>
`;
};

const updateManifest = (id, version, codebase) => `<?xml version="1.0" encoding="UTF-8"?>
<gupdate xmlns="http://www.google.com/update2/response" protocol="2.0">
  <app appid="${id}">
    <updatecheck codebase="${codebase}" version="${version}" />
  </app>
</gupdate>
`;

const run = async () => {
	const manifest = JSON.parse(readFileSync(join(args.dir, "manifest.json"), "utf8"));
	const version = manifest.version;
	const key = args["no-crx"] ? undefined : loadKey();
	if (!args["no-crx"] && !key) throw new Error("Pass --key <pem> or set CRX_PRIVATE_KEY (or --no-crx for a zip only)");
	const codebase = args.codebase?.replace(/\/$/, "");
	if (key) {
		const publicKey = key.publicKeyDer.toString("base64");
		if (manifest.key && manifest.key !== publicKey) {
			throw new Error(`Signing key (id ${key.id}) does not match the manifest key; wrong key file?`);
		}
		manifest.key = publicKey;
		if (codebase) manifest.update_url = `${codebase}/updates.xml`;
	} else {
		// The Web Store rejects uploads that carry a `key`.
		delete manifest.key;
	}

	mkdirSync(args.out, { recursive: true });
	const zip = await buildZip(manifest);
	const zipPath = join(args.out, `sitegeist-${version}.zip`);
	writeFileSync(zipPath, zip);
	console.log(`zip:     ${relative(packageRoot, zipPath)}`);
	if (!key) return;

	const crxName = `sitegeist-${version}.crx`;
	const crxPath = join(args.out, crxName);
	writeFileSync(crxPath, buildCrx(zip, key));
	console.log(`crx:     ${relative(packageRoot, crxPath)}`);
	console.log(`id:      ${key.id}`);
	console.log(`version: ${version}`);

	if (codebase) {
		const xmlPath = join(args.out, "updates.xml");
		writeFileSync(xmlPath, updateManifest(key.id, version, `${codebase}/${crxName}`));
		console.log(`update:  ${relative(packageRoot, xmlPath)} -> ${codebase}/${crxName}`);
	}

	const profilePath = join(args.out, "sitegeist-chrome-policy.mobileconfig");
	writeFileSync(profilePath, policyProfile(key.id, codebase));
	console.log(`policy:  ${relative(packageRoot, profilePath)}`);
};

run().catch((error) => {
	console.error(error.message ?? error);
	process.exitCode = 1;
});
