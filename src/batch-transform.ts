import { S2Error } from "./error.js";
import type {
	AppendRecord as AppendRecordType,
	BytesAppendRecord,
	StringAppendRecord,
} from "./stream.js";
import { meteredSizeBytes } from "./utils.js";

/** Helper type to get the correct AppendRecord type based on format */
type RecordForFormat<F extends "string" | "bytes"> = F extends "string"
	? StringAppendRecord
	: BytesAppendRecord;

export interface BatchTransformArgs {
	/** Duration in milliseconds to wait before flushing a batch (default: 5ms) */
	lingerDuration?: number;
	/** Maximum number of records in a batch (default: 1000, max: 1000) */
	maxBatchRecords?: number;
	/** Maximum batch size in bytes (default: 1 MiB, max: 1 MiB) */
	maxBatchBytes?: number;
	/** Optional fencing token to enforce (remains static across batches) */
	fencing_token?: string;
	/** Optional sequence number to match for first batch (auto-increments for subsequent batches) */
	match_seq_num?: number;
}

/** Batch output type with optional fencing token and match_seq_num */
export type BatchOutput<F extends "string" | "bytes"> = {
	records: RecordForFormat<F>[];
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
 *   lingerDuration: 20,
 *   maxBatchRecords: 100,
 *   maxBatchBytes: 256 * 1024,
 *   match_seq_num: 0  // Optional: auto-increments per batch
 * });
 *
 * // Pipe through the batcher directly to a session
 * readable.pipeThrough(batcher).pipeTo(session);
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
export class BatchTransform<
	F extends "string" | "bytes",
> extends TransformStream<RecordForFormat<F>, BatchOutput<F>> {
	private currentBatch: RecordForFormat<F>[] = [];
	private currentBatchSize: number = 0;
	private lingerTimer: ReturnType<typeof setTimeout> | null = null;
	private controller: TransformStreamDefaultController<BatchOutput<F>> | null =
		null;
	private readonly maxBatchRecords: number;
	private readonly maxBatchBytes: number;
	private readonly lingerDuration: number;
	private readonly fencing_token?: string;
	private next_match_seq_num?: number;
	private expectedFormat?: "string" | "bytes";

	constructor(args?: BatchTransformArgs) {
		let controller: TransformStreamDefaultController<BatchOutput<F>>;

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
		this.lingerDuration = args?.lingerDuration ?? 5;
		this.fencing_token = args?.fencing_token;
		this.next_match_seq_num = args?.match_seq_num;
	}

	private handleRecord(record: RecordForFormat<F>): void {
		// Validate format consistency
		if (!this.expectedFormat) {
			this.expectedFormat = record.format;
		} else if (record.format !== this.expectedFormat) {
			throw new S2Error({
				message: `Cannot batch ${record.format} records with ${this.expectedFormat} records. All records must have the same format.`,
			});
		}

		const recordSize = meteredSizeBytes(record as AppendRecordType);

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
			const batch: BatchOutput<F> = {
				records: [...this.currentBatch],
			};
			if (this.fencing_token !== undefined) {
				batch.fencing_token = this.fencing_token;
			}
			if (match_seq_num !== undefined) {
				batch.match_seq_num = match_seq_num;
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
