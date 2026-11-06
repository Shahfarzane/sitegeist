/**
 * Offscreen document: what the service worker cannot do by itself. It has no audio output and no
 * Worker constructor, and a side panel may not be open at all.
 */

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
