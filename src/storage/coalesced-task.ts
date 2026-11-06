/**
 * Runs an async task one at a time. Requests that arrive during a run collapse into a single
 * follow-up run, so the last request's state is always written and writes never overlap.
 */
export class CoalescedTask {
	private running?: Promise<void>;
	private rerun = false;

	constructor(private readonly task: () => Promise<void>) {}

	/** Resolves once the state at the time of this call has been handled. */
	request(): Promise<void> {
		if (this.running) {
			this.rerun = true;
			return this.running;
		}
		this.running = this.loop();
		return this.running;
	}

	private async loop(): Promise<void> {
		try {
			do {
				this.rerun = false;
				await this.task();
			} while (this.rerun);
		} finally {
			this.running = undefined;
		}
	}
}
