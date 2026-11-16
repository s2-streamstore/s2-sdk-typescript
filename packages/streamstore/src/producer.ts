import createDebug from "debug";
import { type BatchOutput, BatchTransform } from "./batch-transform.js";
import { S2Error, sessionClosedError } from "./error.js";
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

const producerClosedError = (): S2Error =>
	new S2Error({
		message: "Producer is closed",
		status: 400,
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
		return this.ack.start.seqNum + this.index;
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

/** Record state shared by FIFO batch association and acknowledgement tracking. */
type InflightRecord = {
	ackPromise: Promise<IndexedAppendAck>;
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
 * - flush() emits the current partial batch and waits for all records submitted before it
 *   to become durable, without closing the Producer.
 *
 * See the "Producer API" section of the root README for guidance on sizing batches,
 * wiring transforms, and handling application-level ids.
 *
 * @example
 * ```ts
 * const appendSession = await stream.appendSession();
 * const producer = new Producer(new BatchTransform(), appendSession);
 * const writer = producer.writable.getWriter();
 * await writer.write(AppendRecord.string({ body: "hello" }));
 * await writer.close();
 *
 * for await (const ack of producer.readable) {
 *   console.log("record durable at seq", ack.seqNum());
 * }
 *
 * await producer.close();
 * ```
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
	private readonly pendingAckEntries = new Set<InflightRecord>();
	private writableController: WritableStreamDefaultController | null = null;
	/** Records the writable has queued, counted when `writer.write()` is called. */
	private writableAccepted = 0;
	/** Records the writable has handed to its sink. */
	private writableReceived = 0;
	private writableEnded = false;
	private readonly writableWaiters = new Set<() => void>();

	private terminalError: S2Error | null = null;
	private readableController: ReadableStreamDefaultController<IndexedAppendAck> | null =
		null;

	private readonly debugName: string;
	private submitCounter = 0;
	private operationChain: Promise<void> = Promise.resolve();
	private closePromise: Promise<void> | null = null;
	/** Writable records past this count were written after close() was called. */
	private closeFence = Number.POSITIVE_INFINITY;

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
		this.writable = new WritableStream<AppendRecord>(
			{
				start: (controller) => {
					this.writableController = controller;
				},
				write: async (record) => {
					const afterClose = ++this.writableReceived > this.closeFence;
					const submitted = this.enqueueOperation(() =>
						this.submitInternal(record, afterClose),
					);
					this.notifyWritableWaiters();
					try {
						await submitted;
					} catch (err) {
						this.endWritable();
						throw err;
					}
				},
				close: async () => {
					this.endWritable();
					await this.close();
				},
				abort: async (reason) => {
					this.endWritable();
					this.fail(reason);
					await this.close();
				},
			},
			{
				// writer.write() calls size() synchronously, but the sink sees queued
				// records one at a time, later. close() uses this count to wait for
				// the records written before it.
				size: () => {
					this.writableAccepted += 1;
					return 1;
				},
			},
		);

		this.pump = this.runPump();
	}

	/**
	 * Main pump loop: reads batches from transform, submits to session, handles acks.
	 */
	private async runPump(): Promise<void> {
		debugProducer("[%s] pump started", this.debugName);
		const pendingAckHandlers = new Set<Promise<void>>();

		try {
			while (true) {
				const { value: batch, done } = await this.transformReader.read();

				// After a failure, fail() has already rejected this batch's records.
				if (done || this.terminalError) {
					debugProducer("[%s] pump done", this.debugName);
					// Await all pending ack handlers before exiting
					if (!this.terminalError && pendingAckHandlers.size > 0) {
						debugProducer(
							"[%s] pump awaiting %d pending acks",
							this.debugName,
							pendingAckHandlers.size,
						);
						await Promise.all(pendingAckHandlers);
					}
					break;
				}

				debugProducer(
					"[%s] pump got batch: records=%d, match_seq_num=%s, inflightRecords=%d",
					this.debugName,
					batch.records.length,
					batch.matchSeqNum ?? "none",
					this.inflightRecords.length,
				);

				// Records map to batches in order. This batch's outcome now settles
				// these.
				const recordCount = batch.records.length;
				if (this.inflightRecords.length < recordCount) {
					throw new S2Error({
						message: `Internal error: flushed ${recordCount} records but only ${this.inflightRecords.length} inflight entries`,
						status: 500,
						origin: "sdk",
					});
				}
				const associatedRecords = this.inflightRecords.splice(0, recordCount);

				// Submit to AppendSession (blocks on capacity)
				let ticket: BatchSubmitTicket;
				try {
					debugProducer(
						"[%s] pump submitting to session: records=%d, match_seq_num=%s",
						this.debugName,
						batch.records.length,
						batch.matchSeqNum ?? "none",
					);

					const input = AppendInput.create(batch.records, {
						fencingToken: batch.fencingToken,
						matchSeqNum: batch.matchSeqNum,
					});
					ticket = await this.appendSession.submit(input);

					debugProducer("[%s] pump submit returned ticket", this.debugName);
				} catch (err) {
					// Never sent: fail() rejects these with the records still waiting.
					this.inflightRecords.unshift(...associatedRecords);
					const error = this.fail(err);
					debugProducer(
						"[%s] pump submit error: %s",
						this.debugName,
						error.message,
					);

					break;
				}

				// Handle ack asynchronously (non-blocking), tracked for awaiting
				const ackHandler = ticket
					.ack()
					.then((ack) => {
						debugProducer(
							"[%s] pump ack received: seq_num=%d-%d",
							this.debugName,
							ack.start.seqNum,
							ack.end.seqNum,
						);

						for (const [i, record] of associatedRecords.entries()) {
							const indexedAck = new IndexedAppendAck(i, ack);
							record.resolveAck(indexedAck);

							try {
								if (this.readableController) {
									this.readableController.enqueue(indexedAck);
								}
							} catch {
								// Controller may be closed
							}
						}
					})
					.catch((err) => {
						const error = toS2Error(err);
						for (const record of associatedRecords) {
							record.rejectAck(error);
						}
						this.fail(error);
						debugProducer(
							"[%s] pump ack error: %s",
							this.debugName,
							error.message,
						);
					})
					.finally(() => {
						pendingAckHandlers.delete(ackHandler);
					});
				pendingAckHandlers.add(ackHandler);
			}
		} catch (err) {
			const error = this.fail(err);
			debugProducer(
				"[%s] pump caught error: %s",
				this.debugName,
				error.message,
			);
		}
	}

	/**
	 * Submit a single record for appending.
	 *
	 * Returns a promise that resolves to a RecordSubmitTicket once the record has been
	 * accepted. The promise blocks if the underlying AppendSession is at capacity
	 * (backpressure is applied via the transform stream).
	 *
	 * @throws S2Error if the Producer has failed, or close() was called before this
	 */
	submit(record: AppendRecord): Promise<RecordSubmitTicket> {
		const afterClose = this.closePromise !== null;
		return this.enqueueOperation(() => this.submitInternal(record, afterClose));
	}

	/** The writable has closed, aborted or errored, and will hand over no more records. */
	private endWritable(): void {
		this.writableEnded = true;
		this.notifyWritableWaiters();
	}

	private notifyWritableWaiters(): void {
		for (const waiter of this.writableWaiters) {
			waiter();
		}
	}

	/**
	 * Enqueues `operation` once the sink has received every record written to
	 * `writable` before this call, or the writable has ended.
	 */
	private enqueueAfterWritable<T>(operation: () => Promise<T>): Promise<T> {
		const count = this.writableAccepted;
		const received = () => this.writableEnded || this.writableReceived >= count;
		if (received()) {
			return this.enqueueOperation(operation);
		}
		return new Promise<T>((resolve) => {
			const waiter = () => {
				if (received()) {
					this.writableWaiters.delete(waiter);
					resolve(this.enqueueOperation(operation));
				}
			};
			this.writableWaiters.add(waiter);
		});
	}

	private async submitInternal(
		record: AppendRecord,
		afterClose: boolean,
	): Promise<RecordSubmitTicket> {
		const submitId = ++this.submitCounter;

		debugProducer(
			"[%s] submit #%d: inflightRecords=%d",
			this.debugName,
			submitId,
			this.inflightRecords.length,
		);

		// The Producer already failed: rethrow the original error (as close() does)
		// so its type is preserved.
		if (this.terminalError) {
			debugProducer(
				"[%s] submit #%d: producer already failed",
				this.debugName,
				submitId,
			);
			throw this.terminalError;
		}

		if (afterClose) {
			throw producerClosedError();
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
		const entry: InflightRecord = { ackPromise, resolveAck, rejectAck };
		this.pendingAckEntries.add(entry);
		void ackPromise.then(
			() => this.pendingAckEntries.delete(entry),
			() => this.pendingAckEntries.delete(entry),
		);
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

			// Also rejects this record, still in inflightRecords.
			const error = this.fail(err);
			throw error;
		}

		// Write succeeded - return ticket immediately
		return new RecordSubmitTicket(ackPromise);
	}

	/**
	 * Force the current partial batch to be emitted and wait for every record
	 * submitted, or written to `writable`, before this call to become durable.
	 *
	 * An empty flush does not append a batch, and the Producer remains open for
	 * further submissions. Submissions queued after this call are excluded, unless
	 * earlier writes to `writable` were still queued in the stream, in which case
	 * they may be included. If an append included in this flush fails, this
	 * throws the error the Producer failed with.
	 */
	flush(): Promise<void> {
		return this.enqueueAfterWritable(async () => {
			if (this.terminalError) {
				throw this.terminalError;
			}

			const pendingAckPromises = [...this.pendingAckEntries].map(
				(entry) => entry.ackPromise,
			);
			try {
				this.batchTransform.flush();
			} catch (err) {
				const error = this.fail(err);
				await Promise.allSettled(pendingAckPromises);
				throw error;
			}
			await Promise.allSettled(pendingAckPromises);

			if (this.terminalError) {
				throw this.terminalError;
			}
		});
	}

	/**
	 * Close the Producer gracefully.
	 *
	 * Waits for all pending records to be flushed, submitted, and acknowledged,
	 * including records written to `writable` before this call. Records submitted
	 * or written after it are rejected, and once closed, `writable` errors with
	 * the same error this method throws, or "Producer is closed". If any error
	 * occurred during the Producer's lifetime, this method throws it.
	 */
	async close(): Promise<void> {
		if (!this.closePromise) {
			this.closeFence = this.writableAccepted;
			this.closePromise = this.enqueueAfterWritable(() =>
				this.closeInternal(),
			).then(
				() => this.fenceWritable(producerClosedError()),
				(err: unknown) => {
					this.fenceWritable(err);
					throw err;
				},
			);
		}
		return this.closePromise;
	}

	/** Ends the writable once the Producer has closed, so writers and pipes into it stop. */
	private fenceWritable(error: unknown): void {
		if (this.writableEnded) {
			return;
		}
		this.endWritable();
		this.writableController?.error(error);
	}

	private enqueueOperation<T>(operation: () => Promise<T>): Promise<T> {
		const operationPromise = this.operationChain.then(operation);
		this.operationChain = operationPromise.then(
			() => undefined,
			() => undefined,
		);
		return operationPromise;
	}

	private fail(cause: unknown): S2Error {
		if (!this.terminalError) {
			// The session's own error, not the SESSION_CLOSED a later batch gets.
			this.terminalError = toS2Error(
				this.appendSession.failureCause() ?? cause,
			);
		}
		const error = this.terminalError;

		// Sent records settle from their batch's ack. These were never sent.
		if (this.inflightRecords.length > 0) {
			const unsentError = sessionClosedError();
			for (const record of this.inflightRecords.splice(0)) {
				record.rejectAck(unsentError);
			}
		}
		this.transformReader.cancel(error).catch(() => {});

		try {
			this.readableController?.error(error);
		} catch {
			// Controller may already be closed or errored.
		}
		this.readableController = null;

		return error;
	}

	private async closeInternal(): Promise<void> {
		debugProducer("[%s] close requested", this.debugName);

		// Close the writer to signal no more records.
		// May fail if the pump already errored and cancelled the transform.
		try {
			await this.transformWriter.close();
		} catch {
			// Writer already errored from a terminal failure — that's fine.
		}

		// Wait for the pump to finish processing all batches
		await this.pump;

		// Close the underlying session
		await this.appendSession.close();

		// Reject any remaining inflight records (shouldn't happen in normal operation)
		if (this.inflightRecords.length > 0) {
			this.fail(
				new S2Error({
					message: "Producer closed with pending records",
					status: 499,
					origin: "sdk",
				}),
			);
		}

		// Close the readable stream
		if (this.readableController) {
			try {
				this.readableController.close();
			} catch {
				// Controller may already be errored or closed
			}
			this.readableController = null;
		}

		debugProducer("[%s] close complete", this.debugName);

		// If an error occurred, throw it
		if (this.terminalError) {
			throw this.terminalError;
		}
	}

	async [Symbol.asyncDispose](): Promise<void> {
		await this.close();
	}
}
