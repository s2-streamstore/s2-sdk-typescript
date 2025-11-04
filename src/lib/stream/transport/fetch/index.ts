import type { S2RequestOptions } from "../../../../common.js";
import { RangeNotSatisfiableError, S2Error } from "../../../../error.js";
import {
	type Client,
	createClient,
	createConfig,
} from "../../../../generated/client/index.js";
import type {
	AppendAck,
	ReadBatch as GeneratedReadBatch,
	StreamPosition,
} from "../../../../generated/index.js";
import { read } from "../../../../generated/index.js";
import { meteredSizeBytes } from "../../../../utils.js";
import { decodeFromBase64 } from "../../../base64.js";
import { EventStream } from "../../../event-stream.js";
import * as Redacted from "../../../redacted.js";
import type {
	AppendArgs,
	AppendRecord,
	AppendSession,
	AppendSessionOptions,
	ReadArgs,
	ReadBatch,
	ReadRecord,
	ReadSession,
	SessionTransport,
	TransportConfig,
} from "../../types.js";
import { streamAppend } from "./shared.js";

export class FetchReadSession<
	Format extends "string" | "bytes" = "string",
> extends EventStream<ReadRecord<Format>> {
	static async create<Format extends "string" | "bytes" = "string">(
		client: Client,
		name: string,
		args?: ReadArgs<Format>,
		options?: S2RequestOptions,
	) {
		console.log("FetchReadSession.create", name, args);
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
		const format = (args?.as ?? "string") as Format;
		return new FetchReadSession(response.response.body, format);
	}

	private _lastReadPosition: StreamPosition | undefined = undefined;

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
					this._lastReadPosition = batch.tail;
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

	public lastReadPosition() {
		return this._lastReadPosition;
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

/**
 * Session for appending records to a stream.
 * Queues append requests and ensures only one is in-flight at a time.
 */
export class FetchAppendSession
	implements ReadableWritablePair<AppendAck, AppendArgs>, AsyncDisposable
{
	private _lastAckedPosition: AppendAck | undefined = undefined;
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
	private readonly stream: string;
	private acksController:
		| ReadableStreamDefaultController<AppendAck>
		| undefined;
	private _readable: AcksStream;
	private _writable: WritableStream<AppendArgs>;
	private closed = false;
	private processingPromise: Promise<void> | null = null;
	private queuedBytes = 0;
	private readonly maxQueuedBytes: number;
	private waitingForCapacity: Array<() => void> = [];
	private readonly client: Client;

	public readonly readable: ReadableStream<AppendAck>;
	public readonly writable: WritableStream<AppendArgs>;

	static async create(
		stream: string,
		transportConfig: TransportConfig,
		sessionOptions?: AppendSessionOptions,
		requestOptions?: S2RequestOptions,
	): Promise<FetchAppendSession> {
		return new FetchAppendSession(
			stream,
			transportConfig,
			sessionOptions,
			requestOptions,
		);
	}

	private constructor(
		stream: string,
		transportConfig: TransportConfig,
		sessionOptions?: AppendSessionOptions,
		requestOptions?: S2RequestOptions,
	) {
		this.options = requestOptions;
		this.stream = stream;
		this.maxQueuedBytes = sessionOptions?.maxQueuedBytes ?? 10 * 1024 * 1024; // 10 MiB default
		this.client = createClient(
			createConfig({
				baseUrl: transportConfig.baseUrl,
				auth: () => Redacted.value(transportConfig.accessToken),
			}),
		);
		// Create the readable stream for acks
		this._readable = new AcksStream((controller) => {
			this.acksController = controller;
		});
		this.readable = this._readable;

		// Create the writable stream
		let writableController: WritableStreamDefaultController;
		this._writable = new WritableStream<AppendArgs>({
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
		this.writable = this._writable;
	}

	async [Symbol.asyncDispose]() {
		await this.close();
	}

	/**
	 * Get a stream of acknowledgements for appends.
	 */
	acks(): AcksStream {
		return this._readable;
	}

	/**
	 * Close the append session.
	 * Waits for all pending appends to complete before resolving.
	 */
	async close(): Promise<void> {
		await this.writable.close();
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
				const ack = await streamAppend(
					this.stream,
					this.client,
					args.records,
					{
						fencing_token: args.fencing_token,
						match_seq_num: args.match_seq_num,
					},
					this.options,
				);
				this._lastAckedPosition = ack;

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

	lastAckedPosition() {
		return this._lastAckedPosition;
	}
}

/**
 * Fetch-based transport using HTTP/1.1 + JSON
 * Works in all JavaScript environments (browser, Node.js, Deno, etc.)
 */
export class FetchTransport implements SessionTransport {
	private readonly client: Client;
	private readonly transportConfig: TransportConfig;
	constructor(config: TransportConfig) {
		this.client = createClient(
			createConfig({
				baseUrl: config.baseUrl,
				auth: () => Redacted.value(config.accessToken),
				headers: config.basinName ? { "s2-basin": config.basinName } : {},
			}),
		);
		this.transportConfig = config;
	}

	async makeAppendSession(
		stream: string,
		sessionOptions?: AppendSessionOptions,
		requestOptions?: S2RequestOptions,
	): Promise<AppendSession> {
		return FetchAppendSession.create(
			stream,
			this.transportConfig,
			sessionOptions,
			requestOptions,
		);
	}

	async makeReadSession<Format extends "string" | "bytes" = "string">(
		stream: string,
		args?: ReadArgs<Format>,
		options?: S2RequestOptions,
	): Promise<ReadSession<Format>> {
		return FetchReadSession.create(this.client, stream, args, options);
	}
}
