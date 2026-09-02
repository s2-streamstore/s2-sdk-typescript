/** Advised reconnects to attempt before staying on. */
const MAX_ADVISED_RECONNECTS = 1;

/** Gap after which the attempt count resets. */
const ADVISED_RECONNECT_IDLE_MS = 60_000;

/**
 * Tracks advised reconnects attempted lately.
 */
export class AdvisedReconnects {
	private count = 0;
	private lastMonotonicMs: number | undefined;

	record(nowMonotonicMs: number = performance.now()): void {
		if (!this.isRecent(nowMonotonicMs)) {
			this.count = 0;
		}
		this.lastMonotonicMs = nowMonotonicMs;
		this.count++;
	}

	/** Whether to act on advice, or stay until the server ends the connection. */
	shouldReconnect(nowMonotonicMs: number = performance.now()): boolean {
		return (
			!this.isRecent(nowMonotonicMs) || this.count < MAX_ADVISED_RECONNECTS
		);
	}

	private isRecent(nowMonotonicMs: number): boolean {
		return (
			this.lastMonotonicMs !== undefined &&
			nowMonotonicMs - this.lastMonotonicMs <= ADVISED_RECONNECT_IDLE_MS
		);
	}
}
