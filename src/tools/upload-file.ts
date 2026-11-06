/**
 * upload_file: give the page a file the chat already has. A click on an upload button opens a
 * native picker no agent can drive, so the file goes straight to the input or drop zone.
 */

import type { AgentMessage, AgentTool } from "@mariozechner/pi-agent-core";
import type { ArtifactsPanel, Attachment } from "@mariozechner/pi-web-ui";
import { type Static, Type } from "@sinclair/typebox";
import { getCurrentBrowserSession } from "../browser/current.js";
import { deliverFiles, type PageFile } from "../browser/page.js";

const schema = Type.Object({
	name: Type.String({ description: "File name of an attachment the user sent, or of an artifact" }),
	selector: Type.Optional(
		Type.String({
			description: "CSS selector of a file input, its label, or a drop zone. Default: the page's file input",
		}),
	),
	text: Type.Optional(Type.String({ description: "Visible text of the target, instead of a selector" })),
});

export const UPLOAD_FILE_TOOL_DESCRIPTION =
	"Attach a file from this chat (a user attachment or an artifact) to the current page. Never click an upload button: it opens a native file picker you cannot use. Without a selector this fills the page's file input, hidden ones included. Anything that is not a file input is treated as a drop zone.";

const MIME_BY_EXTENSION: Record<string, string> = {
	csv: "text/csv",
	gif: "image/gif",
	html: "text/html",
	jpeg: "image/jpeg",
	jpg: "image/jpeg",
	json: "application/json",
	md: "text/markdown",
	pdf: "application/pdf",
	png: "image/png",
	svg: "image/svg+xml",
	txt: "text/plain",
	webp: "image/webp",
};
/** The file travels inside a page script, base64 encoded, and is decoded once more there. */
const MAX_FILE_CHARS = 36 * 1024 * 1024;
const BINARY_ARTIFACT = /\.(png|jpe?g|gif|webp|pdf|zip|xlsx|docx|pptx)$/i;

function mimeOf(name: string): string {
	return MIME_BY_EXTENSION[name.split(".").pop()?.toLowerCase() ?? ""] ?? "application/octet-stream";
}

function textToBase64(text: string): string {
	const bytes = new TextEncoder().encode(text);
	let binary = "";
	for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
	return btoa(binary);
}

function findAttachment(messages: AgentMessage[], name: string): Attachment | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const attachments = (messages[i] as { attachments?: Attachment[] }).attachments;
		const found = attachments?.find((a) => a.fileName === name);
		if (found) return found;
	}
	return undefined;
}

export function createUploadFileTool(
	messages: () => AgentMessage[],
	artifacts: () => ArtifactsPanel,
): AgentTool<typeof schema, { delivered: string }> {
	return {
		name: "upload_file",
		label: "Upload file",
		description: UPLOAD_FILE_TOOL_DESCRIPTION,
		parameters: schema,
		execute: async (_toolCallId, args: Static<typeof schema>) => {
			let file: PageFile | undefined;
			const attachment = findAttachment(messages(), args.name);
			if (attachment) file = { name: attachment.fileName, mimeType: attachment.mimeType, data: attachment.content };
			const artifact = artifacts().artifacts.get(args.name);
			if (!file && artifact) {
				file = {
					name: artifact.filename,
					mimeType: mimeOf(artifact.filename),
					data: BINARY_ARTIFACT.test(artifact.filename) ? artifact.content : textToBase64(artifact.content),
				};
			}
			if (!file) throw new Error(`No attachment or artifact named ${args.name}`);
			if (file.data.length > MAX_FILE_CHARS) throw new Error(`${file.name} is too large (25 MB at most)`);
			const tab = await getCurrentBrowserSession().attachedCurrentTab();
			if (tab.id === undefined) throw new Error("No tab");
			const result = await deliverFiles(tab.id, { selector: args.selector, text: args.text }, [file]);
			return {
				content: [{ type: "text", text: `${file.name} delivered to the page (${result.delivered}).` }],
				details: { delivered: result.delivered },
			};
		},
	};
}
