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
		let failure: { error: unknown } | undefined;
		do {
			this.rerun = false;
			failure = undefined;
			try {
				await this.task();
			} catch (error) {
				// A request that came in meanwhile still gets its run; only the last outcome counts.
				failure = { error };
			}
		} while (this.rerun);
		this.running = undefined;
		if (failure) throw failure.error;
	}
}
