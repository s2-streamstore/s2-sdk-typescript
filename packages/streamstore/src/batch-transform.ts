import { S2Error } from "./error.js";
import type { AppendAck } from "./generated/index.js";
import type { AppendResult } from "./lib/result.js";
import type {
	AcksStream,
	AppendArgs,
	AppendSession,
	BatchSubmitTicket,
} from "./lib/stream/types.js";
import { AppendRecord, meteredBytes } from "./utils.js";

const toS2Error = (err: unknown): S2Error =>
	err instanceof S2Error
		? err
		: new S2Error({
				message: String(err),
				status: 500,
				origin: "sdk",
			});

export interface BatchTransformArgs {
	/** Duration in milliseconds to wait before flushing a batch (default: 5ms) */
	lingerDurationMillis?: number;
	/** Maximum number of records in a batch (default: 1000, max: 1000) */
	maxBatchRecords?: number;
	/** Maximum batch size in metered bytes (default: 1 MiB, max: 1 MiB) */
	maxBatchBytes?: number;
	/** Optional fencing token to enforce (remains static across batches) */
	fencingToken?: string;
	/** Optional sequence number to match for first batch (auto-increments for subsequent batches) */
	matchSeqNum?: number;
}

/** Batch output type with optional fencing token and matchSeqNum */
export type BatchOutput = {
	records: AppendRecord[];
	fencingToken?: string;
	matchSeqNum?: number;
};

/**
 * A TransformStream that batches AppendRecords based on time, record count, and byte size.
 *
 * Input: AppendRecord (individual records)
 * Output: { records: AppendRecord[], fencingToken?: string, matchSeqNum?: number }
 *
 * @example
 * ```typescript
 * const batcher = new BatchTransform<"string">({
 *   lingerDurationMillis: 20,
 *   maxBatchRecords: 100,
 *   maxBatchBytes: 256 * 1024,
 *   matchSeqNum: 0  // Optional: auto-increments per batch
 * });
 *
 * // Pipe through the batcher and session to get acks
 * readable.pipeThrough(batcher).pipeThrough(session).pipeTo(writable);
 *
 * // Or use manually
 * const writer = batcher.writable.getWriter();
 * writer.write(AppendRecord.make("foo"));
 * await writer.close();
 *
 * for await (const batch of batcher.readable) {
 *   console.log(`Got batch of ${batch.records.length} records`);
 * }
 * ```
 */
export class BatchTransform extends TransformStream<AppendRecord, BatchOutput> {
	private currentBatch: AppendRecord[] = [];
	private currentBatchSize: number = 0;
	private lingerTimer: ReturnType<typeof setTimeout> | null = null;
	private controller: TransformStreamDefaultController<BatchOutput> | null =
		null;
	private readonly maxBatchRecords: number;
	private readonly maxBatchBytes: number;
	private readonly lingerDuration: number;
	private readonly fencingToken?: string;
	private nextMatchSeqNum?: number;

	constructor(args?: BatchTransformArgs) {
		let controller: TransformStreamDefaultController<BatchOutput>;

		super({
			start: (c) => {
				controller = c;
			},
			transform: (chunk, c) => {
				// Store controller reference on first transform
				if (!this.controller) {
					this.controller = c;
				}
				this.handleRecord(chunk);
			},
			flush: () => {
				this.flush();
			},
		});

		// Validate configuration
		if (args?.maxBatchRecords !== undefined) {
			if (args.maxBatchRecords < 1 || args.maxBatchRecords > 1000) {
				throw new S2Error({
					message: `maxBatchRecords must be between 1 and 1000 (inclusive); got ${args.maxBatchRecords}`,
					status: 400,
					origin: "sdk",
				});
			}
		}
		if (args?.maxBatchBytes !== undefined) {
			const max = 1024 * 1024;
			if (args.maxBatchBytes < 1 || args.maxBatchBytes > max) {
				throw new S2Error({
					message: `maxBatchBytes must be between 1 and ${max} (1 MiB) bytes (inclusive); got ${args.maxBatchBytes}`,
					status: 400,
					origin: "sdk",
				});
			}
		}
		if (args?.lingerDurationMillis !== undefined) {
			if (args.lingerDurationMillis < 0) {
				throw new S2Error({
					message: `lingerDurationMillis must be >= 0; got ${args.lingerDurationMillis}`,
					status: 400,
					origin: "sdk",
				});
			}
		}

		// Apply defaults
		this.maxBatchRecords = args?.maxBatchRecords ?? 1000;
		this.maxBatchBytes = args?.maxBatchBytes ?? 1024 * 1024;
		this.lingerDuration = args?.lingerDurationMillis ?? 5;
		this.fencingToken = args?.fencingToken;
		this.nextMatchSeqNum = args?.matchSeqNum;
	}

	private handleRecord(record: AppendRecord): void {
		const recordSize = meteredBytes(record);

		// Reject individual records that exceed the max batch size
		if (recordSize > this.maxBatchBytes) {
			throw new S2Error({
				message: `Record size ${recordSize} bytes exceeds maximum batch size of ${this.maxBatchBytes} bytes`,
				status: 400,
				origin: "sdk",
			});
		}

		// Start linger timer on first record added to an empty batch
		if (this.currentBatch.length === 0 && this.lingerDuration > 0) {
			this.startLingerTimer();
		}

		// Check if adding this record would exceed limits
		const wouldExceedRecords =
			this.currentBatch.length + 1 > this.maxBatchRecords;
		const wouldExceedBytes =
			this.currentBatchSize + recordSize > this.maxBatchBytes;

		if (wouldExceedRecords || wouldExceedBytes) {
			this.flush();
			// Restart linger timer for new batch
			if (this.lingerDuration > 0) {
				this.startLingerTimer();
			}
		}

		// Add record to current batch
		this.currentBatch.push(record);
		this.currentBatchSize += recordSize;

		// Check if we've now reached the limits
		const nowExceedsRecords = this.currentBatch.length >= this.maxBatchRecords;
		const nowExceedsBytes = this.currentBatchSize >= this.maxBatchBytes;

		if (nowExceedsRecords || nowExceedsBytes) {
			this.flush();
		}
	}

	private flush(): void {
		this.cancelLingerTimer();

		if (this.currentBatch.length === 0) {
			return;
		}

		// Auto-increment matchSeqNum for next batch
		const matchSeqNum = this.nextMatchSeqNum;
		if (this.nextMatchSeqNum !== undefined) {
			this.nextMatchSeqNum += this.currentBatch.length;
		}

		// Emit the batch downstream with optional fencing token and matchSeqNum
		if (this.controller) {
			const batch: BatchOutput = {
				records: [...this.currentBatch],
			};
			if (this.fencingToken !== undefined) {
				batch.fencingToken = this.fencingToken;
			}
			if (matchSeqNum !== undefined) {
				batch.matchSeqNum = matchSeqNum;
			}
			this.controller.enqueue(batch);
		}

		// Reset batch
		this.currentBatch = [];
		this.currentBatchSize = 0;
	}

	private startLingerTimer(): void {
		this.cancelLingerTimer();

		this.lingerTimer = setTimeout(() => {
			this.lingerTimer = null;
			if (this.currentBatch.length > 0) {
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
}

export class IndexedAppendAck {
	constructor(
		readonly index: number,
		readonly ack: AppendAck,
	) {}

	batchAppendAck(): AppendAck {
		return this.ack;
	}

	seqNum(): number {
		return this.ack.start.seq_num + this.index;
	}
}

export class RecordSubmitTicket {
	constructor(private readonly ackPromise: Promise<IndexedAppendAck>) {
		// Avoid unhandled rejections if the caller never awaits ack().
		this.ackPromise.catch(() => {});
	}

	/**
	 * Returns a promise that resolves with the AppendAck once the batch is durable.
	 */
	ack(): Promise<IndexedAppendAck> {
		return this.ackPromise;
	}
}

type PendingRecord = {
	ticket: RecordSubmitTicket;
	resolveTicket: (ticket: RecordSubmitTicket) => void;
	rejectTicket: (err: S2Error) => void;
	resolveAck: (ack: IndexedAppendAck) => void;
	rejectAck: (err: S2Error) => void;
};

/**
 * BatchingAppendSession mirrors AppendSession semantics for per-record submissions:
 *
 * - submit(record) resolves immediately while the record is only buffered locally.
 * - Once the buffered batch is flushed and appendSession.submit(...) is invoked, all
 *   subsequent submit(record) calls await that BatchSubmitTicket promise before resolving.
 *   This is the point where ordering/capacity is fixed.
 * - ticket.ack() still waits for the underlying batch ack to resolve before yielding an IndexedAppendAck.
 */
/**
 * Semantics:
 * - `submit(record)` resolves as soon as the record is buffered, unless there is
 *   an outstanding appendSession.submit promise, in which case it waits for that
 *   promise to settle (ordering/capacity fixed).
 * - `ticket.ack()` still waits for the batch's BatchSubmitTicket.ack().
 */
export class BatchingAppendSession implements AsyncDisposable {
	readonly batchTransform: BatchTransform;
	readonly transformWriter: WritableStreamDefaultWriter<AppendRecord>;
	readonly transformReader: ReadableStreamDefaultReader<BatchOutput>;

	readonly pump: Promise<void>;

	readonly appendSession: AppendSession;

	readonly readable: ReadableStream<IndexedAppendAck>;
	readonly writable: WritableStream<AppendRecord>;

	private readonly pendingRecords: PendingRecord[] = [];
	private submissionBarrier: Promise<void> = Promise.resolve();

	private pumpError: Error | null = null;
	private readableController: ReadableStreamDefaultController<IndexedAppendAck> | null =
		null;

	constructor(batchTransform: BatchTransform, appendSession: AppendSession) {
		this.batchTransform = batchTransform;
		this.transformWriter = batchTransform.writable.getWriter();
		this.transformReader = batchTransform.readable.getReader();

		this.appendSession = appendSession;

		// Create readable stream that emits batch acknowledgements
		this.readable = new ReadableStream<IndexedAppendAck>({
			start: (controller) => {
				this.readableController = controller;
			},
			cancel: () => {
				// If readable is cancelled, we should close the session
				this.close().catch(() => {
					// Ignore errors during cleanup
				});
			},
		});

		// Create writable stream that accepts individual records
		this.writable = new WritableStream<AppendRecord>({
			write: async (record) => {
				await this.submit(record);
			},
			close: async () => {
				await this.close();
			},
			abort: async (reason) => {
				// Mark as failed
				this.pumpError = reason;
				await this.close();
			},
		});

		this.pump = this.readPump();
	}

	async readPump(): Promise<void> {
		try {
			while (true) {
				const { value, done } = await this.transformReader.read();

				if (done) {
					break;
				}

				const batch = value!;

				const recordCount = batch.records.length;
				const associatedRecords = this.pendingRecords.splice(0, recordCount);
				if (associatedRecords.length !== recordCount) {
					throw new S2Error({
						message: `Internal error: flushed ${recordCount} records but only ${associatedRecords.length} pending entries`,
						status: 500,
						origin: "sdk",
					});
				}

				let submission: Promise<BatchSubmitTicket>;
				try {
					submission = this.appendSession.submit(batch.records, {
						fencingToken: batch.fencingToken,
						matchSeqNum: batch.matchSeqNum,
					});
				} catch (err) {
					const error = toS2Error(err);
					if (!this.pumpError) {
						this.pumpError = error;
					}
					associatedRecords.forEach((pending) => {
						pending.rejectTicket(error);
						pending.rejectAck(error);
					});
					if (this.readableController) {
						this.readableController.error(error);
					}
					continue;
				}
				const completion = submission.then(
					() => undefined,
					(err) => Promise.reject(toS2Error(err)),
				);
				this.submissionBarrier = this.submissionBarrier.then(() => completion);
				this.submissionBarrier.catch(() => {});

				submission.then(
					async (ticket) => {
						try {
							const ack = await ticket.ack();
							associatedRecords.forEach((pending, index) => {
								const indexedAck = new IndexedAppendAck(index, ack);
								pending.resolveAck(indexedAck);
								if (this.readableController) {
									this.readableController.enqueue(indexedAck);
								}
							});
						} catch (err) {
							const error = toS2Error(err);
							associatedRecords.forEach((pending) => pending.rejectAck(error));

							if (this.readableController) {
								this.readableController.error(error);
							}
						}
					},
					(err) => {
						const error = toS2Error(err);
						if (!this.pumpError) {
							this.pumpError = error;
						}
						associatedRecords.forEach((pending) => {
							pending.rejectTicket(error);
							pending.rejectAck(error);
						});

						if (this.readableController) {
							this.readableController.error(error);
						}
					},
				);
			}
		} catch (err) {
			this.pumpError = err as Error;

			// Reject all pending promises
			const error = new S2Error({
				message: `Pump failed: ${err}`,
				status: 500,
				origin: "sdk",
			});

			for (const pending of this.pendingRecords.splice(0)) {
				pending.rejectTicket(error);
				pending.rejectAck(error);
			}

			// Error the readable stream
			if (this.readableController) {
				this.readableController.error(error);
				this.readableController = null;
			}

			throw err;
		}
	}

	// acks(): AcksStream {
	// 	return undefined;
	// }
	//
	// failureCause(): S2Error | undefined {
	// 	return undefined;
	// }
	//
	// lastAckedPosition(): AppendAck | undefined {
	// 	return undefined;
	// }

	async submit(record: AppendRecord): Promise<RecordSubmitTicket> {
		// Check if pump has already failed
		if (this.pumpError) {
			throw new S2Error({
				message: `Cannot submit: pump has failed: ${this.pumpError}`,
				status: 500,
				origin: "sdk",
			});
		}

		let resolveTicket!: (ticket: RecordSubmitTicket) => void;
		let rejectTicket!: (err: S2Error) => void;
		const ticketPromise = new Promise<RecordSubmitTicket>((resolve, reject) => {
			resolveTicket = resolve;
			rejectTicket = reject;
		});

		let resolveAck!: (ack: IndexedAppendAck) => void;
		let rejectAck!: (err: S2Error) => void;
		const ackPromise = new Promise<IndexedAppendAck>((resolve, reject) => {
			resolveAck = resolve;
			rejectAck = reject;
		});

		const recordTicket = new RecordSubmitTicket(ackPromise);
		const entry: PendingRecord = {
			ticket: recordTicket,
			resolveTicket,
			rejectTicket,
			resolveAck,
			rejectAck,
		};
		this.pendingRecords.push(entry);

		try {
			// Awaiting write enforces backpressure before returning the ticket.
			await this.transformWriter.write(record);
		} catch (err) {
			// Remove resolver if the write failed so we do not leak the slot.
			const idx = this.pendingRecords.indexOf(entry);
			if (idx >= 0) {
				this.pendingRecords.splice(idx, 1);
			}

			const error = toS2Error(err);
			rejectTicket(error);
			rejectAck(error);
			throw error;
		}

		const gate = this.submissionBarrier;
		gate.then(
			() => entry.resolveTicket(entry.ticket),
			(err) => entry.rejectTicket(toS2Error(err)),
		);

		return ticketPromise;
	}

	async close(): Promise<void> {
		// Close the writer to signal no more records
		await this.transformWriter.close();

		// Wait for the pump to finish processing all batches
		await this.pump;

		// Close the underlying session
		await this.appendSession.close();

		const closingError = new S2Error({
			message: "Session closed",
			status: 499,
			origin: "sdk",
		});
		for (const pending of this.pendingRecords.splice(0)) {
			pending.rejectTicket(closingError);
			pending.rejectAck(closingError);
		}

		// Close the readable stream
		if (this.readableController) {
			this.readableController.close();
			this.readableController = null;
		}
	}

	async [Symbol.asyncDispose](): Promise<void> {
		await this.close();
	}
}
