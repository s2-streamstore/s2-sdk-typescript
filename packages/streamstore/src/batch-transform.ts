import { S2Error } from "./error.js";
import { AppendRecord, meteredBytes } from "./utils.js";

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
