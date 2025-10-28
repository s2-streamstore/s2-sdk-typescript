import { S2Error } from "../../error.js";
import type { AppendAck } from "../../generated/index.js";
import type {
	AppendArgs,
	AppendRecord,
	AppendSession,
	Batcher,
	BatcherArgs,
} from "./types.js";

/**
 * Batches individual records and submits them to an AppendSession.
 * Handles linger duration, batch size limits, and auto-incrementing match_seq_num.
 */
export class BatcherImpl
	extends WritableStream<AppendRecord | AppendRecord[]>
	implements Batcher
{
	private session: AppendSession;
	private currentBatch: AppendRecord[] = [];
	private currentBatchResolvers: Array<{
		resolve: (ack: AppendAck) => void;
		reject: (error: any) => void;
	}> = [];
	private lingerTimer: ReturnType<typeof setTimeout> | null = null;
	private closed = false;
	private readonly maxBatchSize: number;
	private readonly lingerDuration: number;
	private readonly fencing_token?: string;
	private next_match_seq_num?: number;

	constructor(session: AppendSession, args?: BatcherArgs) {
		let writableController: WritableStreamDefaultController;

		super({
			start: (controller) => {
				writableController = controller;
			},
			write: (chunk) => {
				const records = Array.isArray(chunk) ? chunk : [chunk];
				this.submit(records);
			},
			close: () => {
				this.closed = true;
				this.flush();
				this.cleanup();
			},
			abort: (reason) => {
				this.closed = true;

				// Reject all pending promises in the current batch
				const error = new S2Error({
					message: `Batcher was aborted: ${reason}`,
				});
				for (const resolver of this.currentBatchResolvers) {
					resolver.reject(error);
				}

				this.currentBatch = [];
				this.currentBatchResolvers = [];
				this.cleanup();
			},
		});

		this.session = session;
		this.maxBatchSize = args?.maxBatchSize ?? 1000;
		this.lingerDuration = args?.lingerDuration ?? 5;
		this.fencing_token = args?.fencing_token;
		this.next_match_seq_num = args?.match_seq_num;
	}

	async [Symbol.asyncDispose]() {
		await this.close();
	}

	/**
	 * Submit one or more records to be batched.
	 * For array submits, the entire array is treated as an atomic unit and will never be split across batches.
	 * If it doesn't fit in the current batch, the current batch is flushed and the array is queued in the next batch.
	 * Returns a promise that resolves when the batch containing these records is acknowledged.
	 */
	submit(records: AppendRecord | AppendRecord[]): Promise<AppendAck> {
		if (this.closed) {
			return Promise.reject(new S2Error({ message: "Batcher is closed" }));
		}

		return new Promise((resolve, reject) => {
			const recordsArray = Array.isArray(records) ? records : [records];
			const isArraySubmit = Array.isArray(records) && records.length > 1;

			// Start linger timer on first record added to an empty batch
			if (this.currentBatch.length === 0 && this.lingerDuration > 0) {
				this.startLingerTimer();
			}

			if (isArraySubmit) {
				// Treat the entire array as atomic: if it doesn't fit, flush current batch first
				if (
					this.currentBatch.length > 0 &&
					this.currentBatch.length + recordsArray.length > this.maxBatchSize
				) {
					this.flush();
					// After flush, if linger is enabled, restart the timer for the new batch
					if (this.lingerDuration > 0) {
						this.startLingerTimer();
					}
				}

				// Add the entire array (even if it exceeds maxBatchSize) as a single batch unit
				this.currentBatch.push(...recordsArray);
				this.currentBatchResolvers.push({ resolve, reject });
				// Do not auto-flush here; allow linger timer or explicit flush to send the batch
			} else {
				// Single record submit — normal behavior
				if (this.currentBatch.length >= this.maxBatchSize) {
					this.flush();
					if (this.lingerDuration > 0) {
						this.startLingerTimer();
					}
				}
				this.currentBatch.push(recordsArray[0]!);
				this.currentBatchResolvers.push({ resolve, reject });
				if (this.currentBatch.length >= this.maxBatchSize) {
					this.flush();
				}
			}
		});
	}

	/**
	 * Flush the current batch to the session.
	 */
	flush(): void {
		this.cancelLingerTimer();

		if (this.currentBatch.length === 0) {
			return;
		}

		const args: AppendArgs = {
			records: this.currentBatch,
			fencing_token: this.fencing_token,
			match_seq_num: this.next_match_seq_num,
		};

		// Auto-increment match_seq_num for next batch
		if (this.next_match_seq_num !== undefined) {
			this.next_match_seq_num += this.currentBatch.length;
		}

		// Capture resolvers for this batch
		const batchResolvers = this.currentBatchResolvers;
		this.currentBatchResolvers = [];
		this.currentBatch = [];

		// Submit to session and handle promise
		const promise = this.session.submit(args.records, {
			fencing_token: args.fencing_token,
			match_seq_num: args.match_seq_num,
		});

		// Resolve/reject all resolvers for this batch when the ack comes back
		promise.then(
			(ack) => {
				for (const resolver of batchResolvers) {
					resolver.resolve(ack);
				}
			},
			(error) => {
				for (const resolver of batchResolvers) {
					resolver.reject(error);
				}
			},
		);
	}

	private startLingerTimer(): void {
		this.cancelLingerTimer();

		this.lingerTimer = setTimeout(() => {
			this.lingerTimer = null;
			if (!this.closed && this.currentBatch.length > 0) {
				this.flush();
			}
		}, this.lingerDuration);
	}

	private cancelLingerTimer(): void {
		if (this.lingerTimer) {
			clearTimeout(this.lingerTimer);
			this.lingerTimer = null;
		}
	}

	private cleanup(): void {
		this.cancelLingerTimer();
	}
}
