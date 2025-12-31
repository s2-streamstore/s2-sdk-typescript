import createDebug from "debug";
import { type BatchOutput, BatchTransform } from "./batch-transform.js";
import { S2Error } from "./error.js";
import type { AppendSession, BatchSubmitTicket } from "./lib/stream/types.js";
import { type AppendAck, AppendInput, type AppendRecord } from "./types.js";

const debugProducer = createDebug("s2:producer");

const toS2Error = (err: unknown): S2Error =>
	err instanceof S2Error
		? err
		: new S2Error({
				message: String(err),
				status: 500,
				origin: "sdk",
			});

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
	 * Returns a promise that resolves with the IndexedAppendAck once the record is durable.
	 */
	ack(): Promise<IndexedAppendAck> {
		return this.ackPromise;
	}
}

/**
 * Internal record tracking - only needs ack callbacks since submit() resolves
 * based on backpressure from the transform stream write.
 */
type InflightRecord = {
	resolveAck: (ack: IndexedAppendAck) => void;
	rejectAck: (err: S2Error) => void;
};

/**
 * Producer provides per-record append semantics on top of a batched AppendSession.
 *
 * - submit(record) returns a Promise<RecordSubmitTicket> that resolves once the record
 *   has been accepted (written to the batch transform). Backpressure is applied
 *   automatically via the transform stream when the AppendSession is at capacity.
 * - ticket.ack() returns a Promise<IndexedAppendAck> that resolves once the record is durable.
 *
 * See docs/producer-spec.md for detailed specification.
 */
export class Producer implements AsyncDisposable {
	readonly batchTransform: BatchTransform;
	readonly transformWriter: WritableStreamDefaultWriter<AppendRecord>;
	readonly transformReader: ReadableStreamDefaultReader<BatchOutput>;

	readonly pump: Promise<void>;

	readonly appendSession: AppendSession;

	readonly readable: ReadableStream<IndexedAppendAck>;
	readonly writable: WritableStream<AppendRecord>;

	private readonly inflightRecords: InflightRecord[] = [];

	private pumpError: S2Error | null = null;
	private readableController: ReadableStreamDefaultController<IndexedAppendAck> | null =
		null;

	private readonly debugName: string;
	private submitCounter = 0;

	constructor(
		batchTransform: BatchTransform,
		appendSession: AppendSession,
		debugName?: string,
	) {
		this.debugName = debugName ?? `producer-${Date.now()}`;
		this.batchTransform = batchTransform;
		this.transformWriter = batchTransform.writable.getWriter();
		this.transformReader = batchTransform.readable.getReader();

		this.appendSession = appendSession;
		debugProducer("[%s] created", this.debugName);

		// Create readable stream that emits individual record acknowledgements
		this.readable = new ReadableStream<IndexedAppendAck>({
			start: (controller) => {
				this.readableController = controller;
			},
			cancel: () => {
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
				this.pumpError = toS2Error(reason);
				await this.close();
			},
		});

		this.pump = this.runPump();
	}

	/**
	 * Main pump loop: reads batches from transform, submits to session, handles acks.
	 */
	private async runPump(): Promise<void> {
		debugProducer("[%s] pump started", this.debugName);

		try {
			while (true) {
				const { value: batch, done } = await this.transformReader.read();

				if (done) {
					debugProducer("[%s] pump done (transform closed)", this.debugName);
					break;
				}

				debugProducer(
					"[%s] pump got batch: records=%d, match_seq_num=%s, inflightRecords=%d",
					this.debugName,
					batch.records.length,
					batch.match_seq_num ?? "none",
					this.inflightRecords.length,
				);

				// Associate records with this batch (FIFO correspondence)
				const recordCount = batch.records.length;
				const associatedRecords = this.inflightRecords.splice(0, recordCount);

				if (associatedRecords.length !== recordCount) {
					throw new S2Error({
						message: `Internal error: flushed ${recordCount} records but only ${associatedRecords.length} inflight entries`,
						status: 500,
						origin: "sdk",
					});
				}

				// Submit to AppendSession (blocks on capacity)
				let ticket: BatchSubmitTicket;
				try {
					debugProducer(
						"[%s] pump submitting to session: records=%d, match_seq_num=%s",
						this.debugName,
						batch.records.length,
						batch.match_seq_num ?? "none",
					);

					const input = AppendInput.create(batch.records, {
						fencingToken: batch.fencing_token,
						matchSeqNum: batch.match_seq_num,
					});
					ticket = await this.appendSession.submit(input);

					debugProducer("[%s] pump submit returned ticket", this.debugName);
				} catch (err) {
					const error = toS2Error(err);
					debugProducer(
						"[%s] pump submit error: %s",
						this.debugName,
						error.message,
					);

					if (!this.pumpError) {
						this.pumpError = error;
					}

					// Reject acks for records in this batch
					for (const record of associatedRecords) {
						record.rejectAck(error);
					}

					if (this.readableController) {
						this.readableController.error(error);
					}

					continue;
				}

				// Handle ack asynchronously (non-blocking)
				ticket
					.ack()
					.then((ack) => {
						debugProducer(
							"[%s] pump ack received: seq_num=%d-%d",
							this.debugName,
							ack.start.seq_num,
							ack.end.seq_num,
						);

						for (const [i, record] of associatedRecords.entries()) {
							const indexedAck = new IndexedAppendAck(i, ack);
							record.resolveAck(indexedAck);

							if (this.readableController) {
								this.readableController.enqueue(indexedAck);
							}
						}
					})
					.catch((err) => {
						const error = toS2Error(err);
						debugProducer(
							"[%s] pump ack error: %s",
							this.debugName,
							error.message,
						);

						if (!this.pumpError) {
							this.pumpError = error;
						}

						for (const record of associatedRecords) {
							record.rejectAck(error);
						}

						if (this.readableController) {
							this.readableController.error(error);
						}
					});
			}
		} catch (err) {
			const error = toS2Error(err);
			debugProducer(
				"[%s] pump caught error: %s",
				this.debugName,
				error.message,
			);

			if (!this.pumpError) {
				this.pumpError = error;
			}

			// Reject all remaining inflight records
			for (const record of this.inflightRecords.splice(0)) {
				record.rejectAck(error);
			}

			// Error the readable stream
			if (this.readableController) {
				this.readableController.error(error);
				this.readableController = null;
			}
		}
	}

	/**
	 * Submit a single record for appending.
	 *
	 * Returns a promise that resolves to a RecordSubmitTicket once the record has been
	 * accepted. The promise blocks if the underlying AppendSession is at capacity
	 * (backpressure is applied via the transform stream).
	 *
	 * @throws S2Error if the Producer has failed
	 */
	async submit(record: AppendRecord): Promise<RecordSubmitTicket> {
		const submitId = ++this.submitCounter;

		debugProducer(
			"[%s] submit #%d: inflightRecords=%d",
			this.debugName,
			submitId,
			this.inflightRecords.length,
		);

		// Check if pump has already failed
		if (this.pumpError) {
			debugProducer(
				"[%s] submit #%d: pump already failed",
				this.debugName,
				submitId,
			);
			throw new S2Error({
				message: `Cannot submit: producer has failed: ${this.pumpError.message}`,
				status: 500,
				origin: "sdk",
			});
		}

		// Create the ack promise (resolved later by pump)
		let resolveAck!: (ack: IndexedAppendAck) => void;
		let rejectAck!: (err: S2Error) => void;
		const ackPromise = new Promise<IndexedAppendAck>((resolve, reject) => {
			resolveAck = resolve;
			rejectAck = reject;
		});
		// Suppress unhandled rejection if write fails before we return the ticket
		ackPromise.catch(() => {});

		// Track this record
		const entry: InflightRecord = { resolveAck, rejectAck };
		this.inflightRecords.push(entry);

		debugProducer(
			"[%s] submit #%d: pushed to inflightRecords (now %d), writing to transform",
			this.debugName,
			submitId,
			this.inflightRecords.length,
		);

		try {
			// Write to transform - BLOCKS on backpressure
			await this.transformWriter.write(record);

			debugProducer(
				"[%s] submit #%d: write completed",
				this.debugName,
				submitId,
			);
		} catch (err) {
			debugProducer(
				"[%s] submit #%d: write failed: %s",
				this.debugName,
				submitId,
				err,
			);

			// Remove from inflight if the write failed
			const idx = this.inflightRecords.indexOf(entry);
			if (idx >= 0) {
				this.inflightRecords.splice(idx, 1);
			}

			const error = toS2Error(err);
			rejectAck(error);
			throw error;
		}

		// Write succeeded - return ticket immediately
		return new RecordSubmitTicket(ackPromise);
	}

	/**
	 * Close the Producer gracefully.
	 *
	 * Waits for all pending records to be flushed, submitted, and acknowledged.
	 * If any error occurred during the Producer's lifetime, this method throws it.
	 */
	async close(): Promise<void> {
		debugProducer("[%s] close requested", this.debugName);

		// Close the writer to signal no more records
		await this.transformWriter.close();

		// Wait for the pump to finish processing all batches
		await this.pump;

		// Close the underlying session
		await this.appendSession.close();

		// Reject any remaining inflight records (shouldn't happen in normal operation)
		if (this.inflightRecords.length > 0) {
			const closingError = new S2Error({
				message: "Producer closed with pending records",
				status: 499,
				origin: "sdk",
			});

			for (const record of this.inflightRecords.splice(0)) {
				record.rejectAck(closingError);
			}
		}

		// Close the readable stream
		if (this.readableController) {
			this.readableController.close();
			this.readableController = null;
		}

		debugProducer("[%s] close complete", this.debugName);

		// If an error occurred, throw it
		if (this.pumpError) {
			throw this.pumpError;
		}
	}

	async [Symbol.asyncDispose](): Promise<void> {
		await this.close();
	}
}
