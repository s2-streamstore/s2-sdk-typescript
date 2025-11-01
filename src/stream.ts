import type { S2RequestOptions } from "./common.js";
import {
	FencingTokenMismatchError,
	RangeNotSatisfiableError,
	S2Error,
	SeqNumMismatchError,
} from "./error.js";
import type { Client } from "./generated/client/types.gen.js";
import {
	type AppendAck,
	append,
	checkTail,
	type AppendInput as GeneratedAppendInput,
	type AppendRecord as GeneratedAppendRecord,
	type ReadBatch as GeneratedReadBatch,
	type SequencedRecord as GeneratedSequencedRecord,
	type ReadData,
	read,
	type StreamPosition,
} from "./generated/index.js";
import { decodeFromBase64, encodeToBase64 } from "./lib/base64.js";
import { EventStream } from "./lib/event-stream.js";
import { computeAppendRecordFormat, meteredSizeBytes } from "./utils.js";

export class S2Stream {
	private readonly client: Client;

	public readonly name: string;

	constructor(name: string, client: Client) {
		this.name = name;
		this.client = client;
	}

	/**
	 * Check the tail of the stream.
	 *
	 * Returns the next sequence number and timestamp to be assigned (`tail`).
	 */
	public async checkTail(options?: S2RequestOptions) {
		const response = await checkTail({
			client: this.client,
			path: {
				stream: this.name,
			},
			...options,
		});

		if (response.error) {
			throw new S2Error({
				message: response.error.message,
				code: response.error.code ?? undefined,
				status: response.response.status,
			});
		}

		return response.data;
	}

	/**
	 * Read records from the stream.
	 *
	 * - When `as: "bytes"` is provided, bodies and headers are decoded from base64 to `Uint8Array`.
	 * - Supports starting position by `seq_num`, `timestamp`, or `tail_offset` and can clamp to the tail.
	 * - Non-streaming reads are bounded by `count` and `bytes` (defaults 1000 and 1 MiB).
	 * - Use `readSession` for streaming reads
	 */
	public async read<Format extends "string" | "bytes" = "string">(
		args?: ReadArgs<Format>,
		options?: S2RequestOptions,
	): Promise<ReadBatch<Format>> {
		const { as, ...queryParams } = args ?? {};
		const response = await read({
			client: this.client,
			path: {
				stream: this.name,
			},
			headers: {
				...(as === "bytes" ? { "s2-format": "base64" } : {}),
			},
			query: queryParams,
			...options,
		});
		if (response.error) {
			if ("message" in response.error) {
				throw new S2Error({
					message: response.error.message,
					code: response.error.code ?? undefined,
					status: response.response.status,
				});
			} else {
				// special case for 416 - Range Not Satisfiable
				throw new RangeNotSatisfiableError({
					status: response.response.status,
				});
			}
		}

		if (args?.as === "bytes") {
			const res: ReadBatch<"bytes"> = {
				...response.data,
				records: response.data.records?.map(
					(record: GeneratedSequencedRecord) => ({
						...record,
						body: record.body ? decodeFromBase64(record.body) : undefined,
						headers: record.headers?.map(
							(header: [string, string]) =>
								header.map((h: string) => decodeFromBase64(h)) as [
									Uint8Array,
									Uint8Array,
								],
						),
					}),
				),
			};
			return res as ReadBatch<Format>;
		} else {
			const res: ReadBatch<"string"> = {
				...response.data,
				records: response.data.records.map((record) => ({
					...record,
					headers: record.headers
						? Object.fromEntries(record.headers)
						: undefined,
				})),
			};
			return res as ReadBatch<Format>;
		}
	}
	/**
	 * Append one or more records to the stream.
	 *
	 * - Automatically base64-encodes when format is "bytes".
	 * - Supports conditional appends via `fencing_token` and `match_seq_num`.
	 * - Returns the acknowledged range and the stream tail after the append.
	 *
	 * All records in a single append call must use the same format (either all string or all bytes).
	 * For high-throughput sequential appends, use `appendSession()` instead.
	 *
	 * @param records The record(s) to append
	 * @param args Optional append arguments (fencing_token, match_seq_num)
	 * @param options Optional request options
	 */
	public async append(
		records: AppendRecord | AppendRecord[],
		args?: Omit<AppendArgs, "records">,
		options?: S2RequestOptions,
	): Promise<AppendAck> {
		const recordsArray = Array.isArray(records) ? records : [records];

		if (recordsArray.length === 0) {
			throw new S2Error({ message: "Cannot append empty array of records" });
		}

		let batchMeteredSize = 0;

		for (const record of recordsArray) {
			batchMeteredSize += meteredSizeBytes(record);
		}

		if (batchMeteredSize > 1024 * 1024) {
			throw new S2Error({
				message: `Batch size ${batchMeteredSize} bytes exceeds maximum of 1 MiB (1048576 bytes)`,
			});
		}
		if (recordsArray.length > 1000) {
			throw new S2Error({
				message: `Batch of ${recordsArray.length} exceeds maximum batch size of 1000 records`,
			});
		}

		let encodedRecords: GeneratedAppendRecord[] = [];
		let hasAnyBytesRecords = false;

		for (const record of recordsArray) {
			const format = computeAppendRecordFormat(record);
			if (format === "bytes") {
				const formattedRecord = record as AppendRecordForFormat<"bytes">;
				const encodedRecord = {
					...formattedRecord,
					body: formattedRecord.body
						? encodeToBase64(formattedRecord.body)
						: undefined,
					headers: formattedRecord.headers?.map((header) =>
						header.map((h) => encodeToBase64(h)),
					) as [string, string][] | undefined,
				};

				encodedRecords.push(encodedRecord);
			} else {
				// Normalize headers to array format
				const normalizeHeaders = (
					headers: AppendHeaders<"string">,
				): [string, string][] | undefined => {
					if (headers === undefined) {
						return undefined;
					} else if (Array.isArray(headers)) {
						return headers;
					} else {
						return Object.entries(headers);
					}
				};

				const formattedRecord = record as AppendRecordForFormat<"string">;
				const encodedRecord = {
					...formattedRecord,
					headers: formattedRecord.headers
						? normalizeHeaders(formattedRecord.headers)
						: undefined,
				};

				encodedRecords.push(encodedRecord);
			}
		}

		const response = await append({
			client: this.client,
			path: {
				stream: this.name,
			},
			body: {
				fencing_token: args?.fencing_token,
				match_seq_num: args?.match_seq_num,
				records: encodedRecords,
			},
			headers: {
				...(hasAnyBytesRecords ? { "s2-format": "base64" } : {}),
			},
			...options,
		});
		if (response.error) {
			if ("message" in response.error) {
				throw new S2Error({
					message: response.error.message,
					code: response.error.code ?? undefined,
					status: response.response.status,
				});
			} else {
				// special case for 412 - append condition failed
				if ("seq_num_mismatch" in response.error) {
					throw new SeqNumMismatchError({
						message: "Append condition failed: sequence number mismatch",
						code: "APPEND_CONDITION_FAILED",
						status: response.response.status,
						expectedSeqNum: response.error.seq_num_mismatch,
					});
				} else if ("fencing_token_mismatch" in response.error) {
					throw new FencingTokenMismatchError({
						message: "Append condition failed: fencing token mismatch",
						code: "APPEND_CONDITION_FAILED",
						status: response.response.status,
						expectedFencingToken: response.error.fencing_token_mismatch,
					});
				} else {
					// fallback for unknown 412 error format
					throw new S2Error({
						message: "Append condition failed",
						status: response.response.status,
					});
				}
			}
		}
		return response.data;
	}
	/**
	 * Open a streaming read session
	 *
	 * Use the returned session as an async iterable or as a readable stream.
	 * When `as: "bytes"` is provided, bodies and headers are decoded to `Uint8Array`.
	 */
	public async readSession<Format extends "string" | "bytes" = "string">(
		args?: ReadArgs<Format>,
		options?: S2RequestOptions,
	): Promise<ReadSession<Format>> {
		return await ReadSession.create(this.client, this.name, args, options);
	}
	/**
	 * Create an append session that guarantees ordering of submissions.
	 *
	 * Use this to coordinate high-throughput, sequential appends with backpressure.
	 * Records can be either string or bytes format - the format is specified in each record.
	 *
	 * @param options Optional request options
	 */
	public async appendSession(
		sessionOptions?: AppendSessionOptions,
		requestOptions?: S2RequestOptions,
	): Promise<AppendSession> {
		return await AppendSession.create(this, sessionOptions, requestOptions);
	}
}

export type ReadHeaders<Format extends "string" | "bytes" = "string"> =
	Format extends "string"
		? Record<string, string>
		: Array<[Uint8Array, Uint8Array]>;

export type ReadBatch<Format extends "string" | "bytes" = "string"> = Omit<
	GeneratedReadBatch,
	"records"
> & {
	records?: Array<ReadRecord<Format>>;
};

export type ReadRecord<Format extends "string" | "bytes" = "string"> = Omit<
	GeneratedSequencedRecord,
	"body" | "headers"
> & {
	body?: Format extends "string" ? string : Uint8Array;
	headers?: ReadHeaders<Format>;
};

export type ReadArgs<Format extends "string" | "bytes" = "string"> =
	ReadData["query"] & {
		as?: Format;
	};

export type AppendHeaders<Format extends "string" | "bytes" = "string"> =
	Format extends "string"
		? Array<[string, string]> | Record<string, string>
		: Array<[Uint8Array, Uint8Array]>;

export type AppendRecordForFormat<
	Format extends "string" | "bytes" = "string",
> = Omit<GeneratedAppendRecord, "body" | "headers"> & {
	body?: Format extends "string" ? string : Uint8Array;
	headers?: AppendHeaders<Format>;
};

export type AppendRecord =
	| AppendRecordForFormat<"string">
	| AppendRecordForFormat<"bytes">;

export type StringAppendRecord = AppendRecordForFormat<"string">;
export type BytesAppendRecord = AppendRecordForFormat<"bytes">;

export type AppendArgs = Omit<GeneratedAppendInput, "records"> & {
	records: Array<AppendRecord>;
};

export class ReadSession<
	Format extends "string" | "bytes" = "string",
> extends EventStream<ReadRecord<Format>> {
	static async create<Format extends "string" | "bytes" = "string">(
		client: Client,
		name: string,
		args?: ReadArgs<Format>,
		options?: S2RequestOptions,
	) {
		const { as, ...queryParams } = args ?? {};
		const response = await read({
			client,
			path: {
				stream: name,
			},
			headers: {
				accept: "text/event-stream",
				...(as === "bytes" ? { "s2-format": "base64" } : {}),
			},
			query: queryParams,
			parseAs: "stream",
			...options,
		});
		if (response.error) {
			if ("message" in response.error) {
				throw new S2Error({
					message: response.error.message,
					code: response.error.code ?? undefined,
					status: response.response.status,
				});
			} else {
				// special case for 416 - Range Not Satisfiable
				throw new RangeNotSatisfiableError({
					status: response.response.status,
				});
			}
		}
		if (!response.response.body) {
			throw new S2Error({
				message: "No body in SSE response",
			});
		}
		return new ReadSession(response.response.body, args?.as ?? "string");
	}

	private _streamPosition: StreamPosition | undefined = undefined;

	private constructor(stream: ReadableStream<Uint8Array>, format: Format) {
		super(stream, (msg) => {
			// Parse SSE events according to the S2 protocol
			if (msg.event === "batch" && msg.data) {
				const rawBatch: GeneratedReadBatch = JSON.parse(msg.data);
				const batch = (() => {
					// If format is bytes, decode base64 to Uint8Array
					if (format === "bytes") {
						return {
							...rawBatch,
							records: rawBatch.records.map((record) => ({
								...record,
								body: record.body ? decodeFromBase64(record.body) : undefined,
								headers: record.headers?.map((header) =>
									header.map((h) => decodeFromBase64(h)),
								) as [Uint8Array, Uint8Array][],
							})),
						} satisfies ReadBatch<"bytes">;
					} else {
						return {
							...rawBatch,
							records: rawBatch.records.map((record) => ({
								...record,
								headers: record.headers
									? Object.fromEntries(record.headers)
									: undefined,
							})),
						} satisfies ReadBatch<"string">;
					}
				})() as ReadBatch<Format>;
				if (batch.tail) {
					this._streamPosition = batch.tail;
				}
				return { done: false, batch: true, value: batch.records ?? [] };
			}
			if (msg.event === "error") {
				// Handle error events
				throw new S2Error({ message: msg.data ?? "Unknown error" });
			}

			// Skip ping events and other events
			return { done: false };
		});
	}

	public get streamPosition() {
		return this._streamPosition;
	}
}

class AcksStream extends ReadableStream<AppendAck> implements AsyncDisposable {
	constructor(
		setController: (
			controller: ReadableStreamDefaultController<AppendAck>,
		) => void,
	) {
		super({
			start: (controller) => {
				setController(controller);
			},
		});
	}

	async [Symbol.asyncDispose]() {
		await this.cancel("disposed");
	}

	// Polyfill for older browsers
	[Symbol.asyncIterator](): AsyncIterableIterator<AppendAck> {
		const fn = (ReadableStream.prototype as any)[Symbol.asyncIterator];
		if (typeof fn === "function") return fn.call(this);
		const reader = this.getReader();
		return {
			next: async () => {
				const r = await reader.read();
				if (r.done) {
					reader.releaseLock();
					return { done: true, value: undefined };
				}
				return { done: false, value: r.value };
			},
			throw: async (e) => {
				await reader.cancel(e);
				reader.releaseLock();
				return { done: true, value: undefined };
			},
			return: async () => {
				await reader.cancel("done");
				reader.releaseLock();
				return { done: true, value: undefined };
			},
			[Symbol.asyncIterator]() {
				return this;
			},
		};
	}
}

interface AppendSessionOptions {
	/** Maximum bytes to queue before applying backpressure (default: 10 MiB) */
	maxQueuedBytes?: number;
}

/**
 * Session for appending records to a stream.
 * Queues append requests and ensures only one is in-flight at a time.
 */
class AppendSession
	extends WritableStream<AppendArgs>
	implements AsyncDisposable
{
	private _lastSeenPosition: AppendAck | undefined = undefined;
	private queue: Array<{
		records: AppendRecord[];
		fencing_token?: string;
		match_seq_num?: number;
		meteredSize: number;
	}> = [];
	private pendingResolvers: Array<{
		resolve: (ack: AppendAck) => void;
		reject: (error: any) => void;
	}> = [];
	private inFlight = false;
	private readonly options?: S2RequestOptions;
	private readonly stream: S2Stream;
	private acksController:
		| ReadableStreamDefaultController<AppendAck>
		| undefined;
	private _acksStream: AcksStream | undefined;
	private closed = false;
	private processingPromise: Promise<void> | null = null;
	private queuedBytes = 0;
	private readonly maxQueuedBytes: number;
	private waitingForCapacity: Array<() => void> = [];

	static async create(
		stream: S2Stream,
		sessionOptions?: AppendSessionOptions,
		requestOptions?: S2RequestOptions,
	): Promise<AppendSession> {
		return new AppendSession(stream, sessionOptions, requestOptions);
	}

	private constructor(
		stream: S2Stream,
		sessionOptions?: AppendSessionOptions,
		requestOptions?: S2RequestOptions,
	) {
		let writableController: WritableStreamDefaultController;

		super({
			start: (controller) => {
				writableController = controller;
			},
			write: async (chunk) => {
				// Calculate batch size
				let batchMeteredSize = 0;
				for (const record of chunk.records) {
					batchMeteredSize += meteredSizeBytes(record as AppendRecord);
				}

				// Wait for capacity if needed
				while (
					this.queuedBytes + batchMeteredSize > this.maxQueuedBytes &&
					!this.closed
				) {
					await new Promise<void>((resolve) => {
						this.waitingForCapacity.push(resolve);
					});
				}

				// Submit the batch
				this.submit(
					chunk.records,
					{
						fencing_token: chunk.fencing_token ?? undefined,
						match_seq_num: chunk.match_seq_num ?? undefined,
					},
					batchMeteredSize,
				);
			},
			close: async () => {
				this.closed = true;
				await this.waitForDrain();
			},
			abort: async (reason) => {
				this.closed = true;
				this.queue = [];
				this.queuedBytes = 0;

				// Reject all pending promises
				const error = new S2Error({
					message: `AppendSession was aborted: ${reason}`,
				});
				for (const resolver of this.pendingResolvers) {
					resolver.reject(error);
				}
				this.pendingResolvers = [];

				// Reject all waiting for capacity
				for (const resolver of this.waitingForCapacity) {
					resolver();
				}
				this.waitingForCapacity = [];
			},
		});
		this.options = requestOptions;
		this.stream = stream;
		this.maxQueuedBytes = sessionOptions?.maxQueuedBytes ?? 10 * 1024 * 1024; // 10 MiB default
	}

	async [Symbol.asyncDispose]() {
		await this.close();
	}

	/**
	 * Get a stream of acknowledgements for appends.
	 */
	acks(): AcksStream {
		if (!this._acksStream) {
			this._acksStream = new AcksStream((controller) => {
				this.acksController = controller;
			});
		}
		return this._acksStream;
	}

	/**
	 * Submit an append request to the session.
	 * The request will be queued and sent when no other request is in-flight.
	 * Returns a promise that resolves when the append is acknowledged or rejects on error.
	 */
	submit(
		records: AppendRecord | AppendRecord[],
		args?: { fencing_token?: string; match_seq_num?: number },
		precalculatedSize?: number,
	): Promise<AppendAck> {
		if (this.closed) {
			return Promise.reject(
				new S2Error({ message: "AppendSession is closed" }),
			);
		}

		const recordsArray = Array.isArray(records) ? records : [records];

		// Validate batch size limits
		if (recordsArray.length > 1000) {
			return Promise.reject(
				new S2Error({
					message: `Batch of ${recordsArray.length} exceeds maximum batch size of 1000 records`,
				}),
			);
		}

		// Validate metered size (use precalculated if provided)
		let batchMeteredSize = precalculatedSize ?? 0;
		if (batchMeteredSize === 0) {
			for (const record of recordsArray) {
				batchMeteredSize += meteredSizeBytes(record);
			}
		}

		if (batchMeteredSize > 1024 * 1024) {
			return Promise.reject(
				new S2Error({
					message: `Batch size ${batchMeteredSize} bytes exceeds maximum of 1 MiB (1048576 bytes)`,
				}),
			);
		}

		return new Promise((resolve, reject) => {
			this.queue.push({
				records: recordsArray,
				fencing_token: args?.fencing_token,
				match_seq_num: args?.match_seq_num,
				meteredSize: batchMeteredSize,
			});
			this.queuedBytes += batchMeteredSize;
			this.pendingResolvers.push({ resolve, reject });

			// Start processing if not already running
			if (!this.processingPromise) {
				this.processingPromise = this.processLoop();
			}
		});
	}

	/**
	 * Main processing loop that sends queued requests one at a time.
	 */
	private async processLoop(): Promise<void> {
		while (this.queue.length > 0) {
			this.inFlight = true;
			const args = this.queue.shift()!;
			const resolver = this.pendingResolvers.shift()!;

			try {
				const ack = await this.stream.append(
					args.records,
					{
						fencing_token: args.fencing_token,
						match_seq_num: args.match_seq_num,
					},
					this.options,
				);
				this._lastSeenPosition = ack;

				// Emit ack to the acks stream if it exists
				if (this.acksController) {
					this.acksController.enqueue(ack);
				}

				// Resolve the promise for this request
				resolver.resolve(ack);

				// Release capacity and wake up waiting writers
				this.queuedBytes -= args.meteredSize;
				while (this.waitingForCapacity.length > 0) {
					const waiter = this.waitingForCapacity.shift()!;
					waiter();
					// Only wake one at a time - let them check capacity again
					break;
				}
			} catch (error) {
				this.inFlight = false;
				this.processingPromise = null;

				// Reject the promise for this request
				resolver.reject(error);

				// Reject all remaining pending promises
				for (const pendingResolver of this.pendingResolvers) {
					pendingResolver.reject(error);
				}
				this.pendingResolvers = [];

				// Clear the queue and reset queued bytes
				this.queue = [];
				this.queuedBytes = 0;

				// Wake up all waiting writers (they'll see the closed state or retry)
				for (const waiter of this.waitingForCapacity) {
					waiter();
				}
				this.waitingForCapacity = [];

				// Do not rethrow here to avoid unhandled rejection; callers already received rejection
			}

			this.inFlight = false;
		}

		this.processingPromise = null;
	}

	private async waitForDrain(): Promise<void> {
		// Wait for processing to complete
		if (this.processingPromise) {
			await this.processingPromise;
		}

		// Wait until queue is empty and nothing is in flight
		while (this.queue.length > 0 || this.inFlight) {
			await new Promise((resolve) => setTimeout(resolve, 10));
		}

		// Close the acks stream if it exists
		if (this.acksController) {
			this.acksController.close();
		}
	}

	get lastSeenPosition() {
		return this._lastSeenPosition;
	}
}
