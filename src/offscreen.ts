/**
 * Offscreen document: what the service worker cannot do by itself. It has no audio output and no
 * Worker constructor, and a side panel may not be open at all.
 */

import { GIF_PORT, type GifJobMessage, type GifWorkerReply } from "./recording/gif-types.js";

function chime(): void {
	const audio = new AudioContext();
	const gain = audio.createGain();
	gain.connect(audio.destination);
	const start = audio.currentTime;
	gain.gain.setValueAtTime(0.0001, start);
	gain.gain.exponentialRampToValueAtTime(0.18, start + 0.02);
	gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.5);
	for (const [index, frequency] of [660, 880].entries()) {
		const tone = audio.createOscillator();
		tone.type = "sine";
		tone.frequency.value = frequency;
		tone.connect(gain);
		tone.start(start + index * 0.12);
		tone.stop(start + 0.5);
	}
	setTimeout(() => void audio.close(), 800);
}

chrome.runtime.onMessage.addListener((message: { target?: string; type?: string }) => {
	if (message?.target !== "offscreen") return;
	if (message.type === "chime") chime();
});

// A port, not sendMessage: that would copy every frame to every open panel as well.
chrome.runtime.onConnect.addListener((port) => {
	if (port.name !== GIF_PORT) return;
	const worker = new Worker(chrome.runtime.getURL("gif-worker.js"), { type: "module" });
	worker.onmessage = (event: MessageEvent<GifWorkerReply>) => port.postMessage(event.data);
	worker.onerror = (event) => port.postMessage({ type: "error", message: event.message } satisfies GifWorkerReply);
	port.onMessage.addListener((message: GifJobMessage) => worker.postMessage(message));
	port.onDisconnect.addListener(() => worker.terminate());
});
