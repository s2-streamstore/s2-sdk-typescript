import { type BatchOutput, BatchTransform } from "./batch-transform.js";
import { S2Error } from "./error.js";
import type { AppendAck } from "./generated/index.js";
import type { AppendSession, BatchSubmitTicket } from "./lib/stream/types.js";
import { AppendRecord } from "./utils.js";

// TODO this should live in error utils, nothing specific to this module
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
 * Producer mirrors AppendSession semantics for per-record submissions:
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
export class Producer implements AsyncDisposable {
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
