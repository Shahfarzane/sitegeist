/**
 * Writes the native messaging host manifest for every Chromium browser present on
 * this machine, plus the launcher script the manifest points at. Idempotent; run
 * automatically by `sitegeist mcp` when the manifest is missing.
 */

import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { NATIVE_HOST_NAME } from "../../src/bridge/protocol.ts";

/**
 * Stable id from the `key` in static/manifest.chrome.json: the public half of the CRX
 * signing key ("sitegeist CRX signing key" in 1Password DEV), so unpacked builds and
 * signed .crx releases share it.
 */
export const EXTENSION_ID = "lnncppjiohlpejgcbdgoihplimdckddn";

function browserDirs(): string[] {
	const home = homedir();
	if (process.platform === "darwin") {
		const base = join(home, "Library", "Application Support");
		return [
			join(base, "Google", "Chrome"),
			join(base, "Google", "Chrome Beta"),
			join(base, "Google", "Chrome Canary"),
			join(base, "Chromium"),
			join(base, "BraveSoftware", "Brave-Browser"),
			join(base, "Microsoft Edge"),
			join(base, "Arc", "User Data"),
			join(base, "Vivaldi"),
			join(base, "com.operasoftware.Opera"),
			join(base, "net.imput.helium"),
		];
	}
	if (process.platform === "linux") {
		const cfg = join(home, ".config");
		return [
			join(cfg, "google-chrome"),
			join(cfg, "google-chrome-beta"),
			join(cfg, "chromium"),
			join(cfg, "BraveSoftware", "Brave-Browser"),
			join(cfg, "microsoft-edge"),
			join(cfg, "vivaldi"),
			join(cfg, "opera"),
		];
	}
	return [];
}

function launcherPath(): string {
	return join(homedir(), ".config", "sitegeist", process.platform === "win32" ? "host.cmd" : "host");
}

/**
 * process.execPath is the resolved binary, which for Homebrew is the versioned Cellar path
 * (node@24/24.21.0_1). `brew upgrade` deletes it on the next revision and the browser can no
 * longer start the host; the opt symlink (opt/node@24) follows upgrades.
 */
export function stableNodePath(execPath: string): string {
	const match = /^(.*)\/Cellar\/([^/]+)\/[^/]+\/bin\/node$/.exec(execPath);
	if (match) {
		const opt = `${match[1]}/opt/${match[2]}/bin/node`;
		if (existsSync(opt)) return opt;
	}
	return execPath;
}

/**
 * The command a harness should run for `sitegeist mcp`, with absolute paths: GUI apps (the
 * Claude desktop app) do not inherit the shell PATH, so `#!/usr/bin/env node` can find no node.
 */
export function mcpCommand(): string[] {
	return [stableNodePath(process.execPath), process.argv[1], "mcp"];
}

/** Why the browser cannot start the host, if it cannot: the launcher or a path it runs is gone. */
export function launcherProblem(): string | undefined {
	const path = launcherPath();
	if (!existsSync(path)) return `${path} is missing`;
	const paths = [...readFileSync(path, "utf8").matchAll(/"([^"]+)"/g)].map((m) => m[1]).filter((p) => isAbsolute(p));
	const missing = paths.find((p) => !existsSync(p));
	return missing ? `${path} runs ${missing}, which no longer exists` : undefined;
}

function writeLauncher(): string {
	const path = launcherPath();
	mkdirSync(join(homedir(), ".config", "sitegeist"), { recursive: true, mode: 0o700 });
	const node = stableNodePath(process.execPath);
	const script = process.argv[1];
	if (process.platform === "win32") {
		writeFileSync(path, `@echo off\r\n"${node}" "${script}" host %*\r\n`);
	} else {
		writeFileSync(path, `#!/bin/sh\nexec "${node}" "${script}" host "$@"\n`);
		chmodSync(path, 0o755);
	}
	return path;
}

function manifestFor(launcher: string): string {
	return `${JSON.stringify(
		{
			name: NATIVE_HOST_NAME,
			description: "sitegeist browser bridge",
			path: launcher,
			type: "stdio",
			allowed_origins: [`chrome-extension://${EXTENSION_ID}/`],
		},
		null,
		2,
	)}\n`;
}

export interface InstallResult {
	launcher: string;
	written: string[];
	skipped: string[];
}

export function install(options: { force?: boolean } = {}): InstallResult {
	const launcher = writeLauncher();
	const manifest = manifestFor(launcher);
	const written: string[] = [];
	const skipped: string[] = [];

	if (process.platform === "win32") {
		const dir = join(homedir(), ".config", "sitegeist");
		const file = join(dir, `${NATIVE_HOST_NAME}.json`);
		writeFileSync(file, manifest);
		for (const hive of ["Google\\Chrome", "BraveSoftware\\Brave-Browser", "Microsoft\\Edge", "Chromium"]) {
			const key = `HKCU\\Software\\${hive}\\NativeMessagingHosts\\${NATIVE_HOST_NAME}`;
			try {
				execFileSync("reg", ["add", key, "/ve", "/t", "REG_SZ", "/d", file, "/f"], { stdio: "ignore" });
				written.push(key);
			} catch {
				skipped.push(key);
			}
		}
		return { launcher, written, skipped };
	}

	for (const dir of browserDirs()) {
		if (!existsSync(dir)) continue;
		const hostsDir = join(dir, "NativeMessagingHosts");
		const file = join(hostsDir, `${NATIVE_HOST_NAME}.json`);
		if (!options.force && existsSync(file) && readFileSync(file, "utf8") === manifest) {
			skipped.push(file);
			continue;
		}
		mkdirSync(hostsDir, { recursive: true });
		writeFileSync(file, manifest);
		written.push(file);
	}
	return { launcher, written, skipped };
}

/**
 * True when the launcher can run and at least one browser has a current manifest. A launcher
 * whose node or script is gone counts as not installed, so `sitegeist mcp` repairs it on start.
 */
export function isInstalled(): boolean {
	if (process.platform === "win32") return existsSync(join(homedir(), ".config", "sitegeist", `${NATIVE_HOST_NAME}.json`));
	const launcher = launcherPath();
	if (launcherProblem()) return false;
	const manifest = manifestFor(launcher);
	return browserDirs().some((dir) => {
		const file = join(dir, "NativeMessagingHosts", `${NATIVE_HOST_NAME}.json`);
		return existsSync(file) && readFileSync(file, "utf8") === manifest;
	});
}
