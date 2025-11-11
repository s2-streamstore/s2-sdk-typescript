import createDebug from "debug";
import { S2Error } from "./error.js";
import { AppendRecord, meteredSizeBytes } from "./utils.js";

const debug = createDebug("s2:batch_transform");

export interface BatchTransformArgs {
	/** Duration in milliseconds to wait before flushing a batch (default: 5ms) */
	lingerDurationMillis?: number;
	/** Maximum number of records in a batch (default: 1000, max: 1000) */
	maxBatchRecords?: number;
	/** Maximum batch size in metered bytes (default: 1 MiB, max: 1 MiB) */
	maxBatchBytes?: number;
	/** Optional fencing token to enforce (remains static across batches) */
	fencing_token?: string;
	/** Optional sequence number to match for first batch (auto-increments for subsequent batches) */
	match_seq_num?: number;
}

/** Batch output type with optional fencing token and match_seq_num */
export type BatchOutput = {
	records: AppendRecord[];
	fencing_token?: string;
	match_seq_num?: number;
};

/**
 * A TransformStream that batches AppendRecords based on time, record count, and byte size.
 *
 * Input: AppendRecord (individual records)
 * Output: { records: AppendRecord[], fencing_token?: string, match_seq_num?: number }
 *
 * @example
 * ```typescript
 * const batcher = new BatchTransform<"string">({
 *   lingerDurationMillis: 20,
 *   maxBatchRecords: 100,
 *   maxBatchBytes: 256 * 1024,
 *   match_seq_num: 0  // Optional: auto-increments per batch
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
	private readonly fencing_token?: string;
	private next_match_seq_num?: number;

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

		// Cap at maximum allowed values
		this.maxBatchRecords = Math.min(args?.maxBatchRecords ?? 1000, 1000);
		this.maxBatchBytes = Math.min(
			args?.maxBatchBytes ?? 1024 * 1024,
			1024 * 1024,
		);
		this.lingerDuration = args?.lingerDurationMillis ?? 5;
		this.fencing_token = args?.fencing_token;
		this.next_match_seq_num = args?.match_seq_num;
	}

	private handleRecord(record: AppendRecord): void {
		const recordSize = meteredSizeBytes(record);

		// Reject individual records that exceed the max batch size
		if (recordSize > this.maxBatchBytes) {
			throw new S2Error({
				message: `Record size ${recordSize} bytes exceeds maximum batch size of ${this.maxBatchBytes} bytes`,
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

		// Auto-increment match_seq_num for next batch
		const match_seq_num = this.next_match_seq_num;
		if (this.next_match_seq_num !== undefined) {
			this.next_match_seq_num += this.currentBatch.length;
		}

		// Emit the batch downstream with optional fencing token and match_seq_num
		if (this.controller) {
			const batch: BatchOutput = {
				records: [...this.currentBatch],
			};
			if (this.fencing_token !== undefined) {
				batch.fencing_token = this.fencing_token;
			}
			if (match_seq_num !== undefined) {
				batch.match_seq_num = match_seq_num;
			}
			debug({ batch });
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
