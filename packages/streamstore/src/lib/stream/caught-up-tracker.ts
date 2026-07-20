import { S2Error } from "../../error.js";
import type { StreamPosition } from "../../types.js";

/**
 * A caught-up point observed in the input stream but not necessarily delivered
 * to the consumer yet.
 */
export interface CaughtUpBoundary {
	/** The tail reported for this caught-up point. */
	readonly tail: StreamPosition;

	/**
	 * Mark every visible record preceding this boundary as delivered.
	 *
	 * Repeated calls and calls made stale by a newer batch, reconnect, or
	 * terminal state are no-ops.
	 */
	markDelivered(): void;
}

/** A normalized decoded batch or heartbeat observed by a read client. */
export interface CaughtUpBatch {
	/** Number of records before any client-side filtering. */
	readonly recordCount: number;
	/** Sequence number of the final unfiltered record, when present. */
	readonly lastSeqNum?: number;
	/** Tail reported with the batch or heartbeat, when present. */
	readonly tail?: StreamPosition;
}

type CaughtUpWaiter = {
	resolve: (tail: StreamPosition) => void;
	reject: (error: S2Error) => void;
};

function copyPosition(position: StreamPosition): StreamPosition {
	return {
		seqNum: position.seqNum,
		timestamp: new Date(position.timestamp.getTime()),
	};
}

/** Error a pending {@link CaughtUpTracker.caughtUp} call rejects with on a clean end. */
function sessionClosedError(): S2Error {
	return new S2Error({
		message: "Read session ended before catching up",
		code: "SESSION_CLOSED",
		status: 0,
		origin: "sdk",
	});
}

class Boundary implements CaughtUpBoundary {
	readonly tail: StreamPosition;
	private delivered = false;

	constructor(
		private readonly caughtUpTail: StreamPosition,
		private readonly deliver: (tail: StreamPosition) => void,
	) {
		this.tail = copyPosition(caughtUpTail);
	}

	markDelivered(): void {
		if (this.delivered) {
			return;
		}
		this.delivered = true;
		this.deliver(this.caughtUpTail);
	}
}

/**
 * Tracks whether normalized read batches have reached a reported tail and have
 * been delivered through that point.
 *
 * Transport clients call {@link observeBatch} as soon as they decode a batch
 * or heartbeat. Delivery is a separate step: the returned boundary is marked
 * only after all preceding visible records have been consumed. Pending
 * {@link caughtUp} calls survive reconnects, while terminal states settle them.
 */
export class CaughtUpTracker {
	private revision = 0;
	private caughtUpTail: StreamPosition | undefined;
	private waiters: CaughtUpWaiter[] = [];
	private terminal: { error?: S2Error } | undefined;

	observeBatch(input: CaughtUpBatch): CaughtUpBoundary | undefined {
		if (this.terminal) {
			return undefined;
		}

		const revision = ++this.revision;
		this.caughtUpTail = undefined;

		const tail = input.tail;
		const reachesTail =
			tail !== undefined &&
			(input.recordCount === 0 ||
				(input.recordCount > 0 &&
					input.lastSeqNum !== undefined &&
					input.lastSeqNum + 1 === tail.seqNum));
		if (!reachesTail || tail === undefined) {
			return undefined;
		}

		return new Boundary(copyPosition(tail), (caughtUpTail) => {
			this.markDelivered(revision, caughtUpTail);
		});
	}

	/** Mark the tracker behind and invalidate boundaries from the old connection. */
	reconnect(): void {
		if (this.terminal) {
			return;
		}
		this.revision++;
		this.caughtUpTail = undefined;
	}

	/**
	 * End tracking and settle pending waiters.
	 *
	 * A clean end preserves an already caught-up state. An error clears it.
	 */
	end(error?: S2Error): void {
		if (this.terminal) {
			return;
		}

		this.revision++;
		this.terminal = { error };
		if (error) {
			this.caughtUpTail = undefined;
		}

		const waiters = this.waiters.splice(0);
		const rejection = error ?? sessionClosedError();
		for (const waiter of waiters) {
			waiter.reject(rejection);
		}
	}

	isCaughtUp(): boolean {
		return this.caughtUpTail !== undefined;
	}

	caughtUp(): Promise<StreamPosition> {
		if (this.caughtUpTail) {
			return Promise.resolve(copyPosition(this.caughtUpTail));
		}
		if (this.terminal) {
			return Promise.reject(this.terminal.error ?? sessionClosedError());
		}

		const promise = new Promise<StreamPosition>((resolve, reject) => {
			this.waiters.push({ resolve, reject });
		});
		// A caller may intentionally use only isCaughtUp(); do not report the
		// tracker's terminal settlement as an unhandled rejection in that case.
		promise.catch(() => {});
		return promise;
	}

	private markDelivered(revision: number, tail: StreamPosition): void {
		if (this.terminal || revision !== this.revision) {
			return;
		}

		this.caughtUpTail = copyPosition(tail);
		const waiters = this.waiters.splice(0);
		for (const waiter of waiters) {
			waiter.resolve(copyPosition(tail));
		}
	}
}
