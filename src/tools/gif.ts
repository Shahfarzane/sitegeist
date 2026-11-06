/**
 * gif_creator for the panel agent: record what happens in the current tab and save it as a GIF
 * the user can share. The same recorder serves harnesses through the bridge.
 */

import type { AgentTool } from "@mariozechner/pi-agent-core";
import { type Static, Type } from "@sinclair/typebox";
import { getCurrentBrowserSession } from "../browser/current.js";
import { gifRecorderFor } from "../recording/gif-recorder.js";

const schema = Type.Object({
	action: Type.Union(
		[Type.Literal("start_recording"), Type.Literal("stop_recording"), Type.Literal("export"), Type.Literal("clear")],
		{ description: "start_recording, stop_recording, export (saves the GIF to Downloads), clear (discards frames)" },
	),
	filename: Type.Optional(Type.String({ description: "File name for export, e.g. checkout-flow.gif" })),
});

function save(base64: string, filename: string): void {
	const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
	const url = URL.createObjectURL(new Blob([bytes], { type: "image/gif" }));
	const link = document.createElement("a");
	link.href = url;
	link.download = filename;
	link.click();
	setTimeout(() => URL.revokeObjectURL(url), 60000);
}

export function createGifTool(): AgentTool<typeof schema, { frames: number }> {
	return {
		name: "gif_creator",
		label: "Record GIF",
		description:
			"Record the current tab as an animated GIF, to show the user how something works or what you did. Call start_recording, do the steps, then export. The recording includes what is on screen, logged-in details too.",
		parameters: schema,
		execute: async (_toolCallId, args: Static<typeof schema>) => {
			const session = getCurrentBrowserSession();
			const recorder = gifRecorderFor(session);
			let text: string;
			switch (args.action) {
				case "start_recording": {
					const tab = await session.attachedCurrentTab();
					if (tab.id === undefined) throw new Error("No tab");
					await recorder.start(tab.id);
					text = "Recording.";
					break;
				}
				case "stop_recording":
					await recorder.stop();
					text = `Stopped with ${recorder.frameCount} frames.`;
					break;
				case "export": {
					const result = await recorder.export({});
					const filename = args.filename ?? `recording-${Date.now()}.gif`;
					save(result.data, filename);
					text = `Saved ${filename} to Downloads (${result.frames} frames, ${Math.round(result.bytes / 1024)} KB).`;
					break;
				}
				case "clear":
					recorder.clear();
					text = "Frames discarded.";
					break;
			}
			return { content: [{ type: "text", text }], details: { frames: recorder.frameCount } };
		},
	};
}
