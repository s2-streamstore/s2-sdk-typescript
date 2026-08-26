/** Max consecutive advised reconnects before delaying the next one. */
const MAX_IMMEDIATE_ADVISED_RECONNECTS = 3;

/** Delay applied past `MAX_IMMEDIATE_ADVISED_RECONNECTS`. */
const ADVISED_RECONNECT_DELAY_MS = 100;

/** If no reconnect advice arrives for this long, the consecutive count resets. */
const ADVISED_RECONNECT_IDLE_MS = 10_000;

/**
 * Counts consecutive reconnects driven by server advice.
 *
 * A draining server keeps serving the session, so progress cannot tell a storm
 * from an ordinary handover; how rapidly advice repeats can. Poisoning stops a
 * pooled connection from being handed out again, but a fresh connection can
 * still land back on the draining server while it leaves the load balancer's
 * rotation, so the loop is paced rather than left to run at connect speed.
 */
export class AdvisedReconnects {
	private count = 0;
	private lastMonotonicMs: number | undefined;

	/**
	 * Register an advised reconnect and report how long to wait before opening
	 * the next connection.
	 */
	record(nowMonotonicMs: number = performance.now()): number {
		if (
			this.lastMonotonicMs !== undefined &&
			nowMonotonicMs - this.lastMonotonicMs > ADVISED_RECONNECT_IDLE_MS
		) {
			this.count = 0;
		}
		this.lastMonotonicMs = nowMonotonicMs;
		this.count++;
		return this.count > MAX_IMMEDIATE_ADVISED_RECONNECTS
			? ADVISED_RECONNECT_DELAY_MS
			: 0;
	}
}
