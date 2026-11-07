import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { parsePublishedVersion, publishedVersion, updateManifestUrl } from "./release.ts";

const saved = process.env.SITEGEIST_UPDATE_DIR;
let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "sitegeist-release-"));
	process.env.SITEGEIST_UPDATE_DIR = dir;
});

afterEach(() => {
	if (saved === undefined) delete process.env.SITEGEIST_UPDATE_DIR;
	else process.env.SITEGEIST_UPDATE_DIR = saved;
});

const manifest = (version: string) => `<?xml version="1.0" encoding="UTF-8"?>
<gupdate xmlns="http://www.google.com/update2/response" protocol="2.0">
  <app appid="lnncppjiohlpejgcbdgoihplimdckddn">
    <updatecheck codebase="file:///x/sitegeist-${version}.crx" version="${version}" />
  </app>
</gupdate>
`;

test("reads the version from the updatecheck tag, not the xml or protocol version", () => {
	assert.equal(parsePublishedVersion(manifest("1.2.330")), "1.2.330");
	assert.equal(parsePublishedVersion("<gupdate><app><updatecheck codebase='file:///x.crx' version = '1.2.9'/></app></gupdate>"), "1.2.9");
	assert.equal(parsePublishedVersion("<gupdate><app><updatecheck codebase='file:///x.crx'/></app></gupdate>"), undefined);
	assert.equal(parsePublishedVersion("<gupdate protocol=\"2.0\"></gupdate>"), undefined);
});

test("publishedVersion reads updates.xml in the update folder", () => {
	assert.equal(publishedVersion(), undefined);
	writeFileSync(join(dir, "updates.xml"), manifest("1.2.331"));
	assert.equal(publishedVersion(), "1.2.331");
	assert.equal(updateManifestUrl(), `file://${join(dir, "updates.xml")}`);
});
