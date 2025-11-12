import createDebug from "debug";
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
import type { AppendResult, CloseResult } from "../../../result.js";
import { err, errClose, ok, okClose } from "../../../result.js";
import {
	AppendSession as AppendSessionImpl,
	ReadSession as ReadSessionImpl,
} from "../../../retry.js";
import type {
	AppendArgs,
	AppendRecord,
	AppendSession,
	AppendSessionOptions,
	ReadArgs,
	ReadBatch,
	ReadRecord,
	ReadResult,
	ReadSession,
	SessionTransport,
	TransportConfig,
	TransportReadSession,
} from "../../types.js";
import { streamAppend } from "./shared.js";

const debug = createDebug("s2:fetch");

export class FetchReadSession<Format extends "string" | "bytes" = "string">
	extends ReadableStream<ReadResult<Format>>
	implements TransportReadSession<Format>
{
	static async create<Format extends "string" | "bytes" = "string">(
		client: Client,
		name: string,
		args?: ReadArgs<Format>,
		options?: S2RequestOptions,
	) {
		debug("FetchReadSession.create stream=%s args=%o", name, args);
		const { as, ...queryParams } = args ?? {};

		try {
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
				// Convert error to S2Error and return error session
				const error =
					"message" in response.error
						? new S2Error({
								message: response.error.message,
								code: response.error.code ?? undefined,
								status: response.response.status,
							})
						: new RangeNotSatisfiableError({
								status: response.response.status,
							});
				return FetchReadSession.createErrorSession<Format>(error);
			}
			if (!response.response.body) {
				const error = new S2Error({
					message: "No body in SSE response",
					status: 502,
					origin: "sdk",
				});
				return FetchReadSession.createErrorSession<Format>(error);
			}
			const format = (args?.as ?? "string") as Format;
			return new FetchReadSession(response.response.body, format);
		} catch (error) {
			// Catch any thrown errors (network failures, DNS errors, etc.)
			const s2Error =
				error instanceof S2Error
					? error
					: new S2Error({
							message: String(error),
							status: 502, // Bad Gateway - network/fetch failure
						});
			return FetchReadSession.createErrorSession<Format>(s2Error);
		}
	}

	/**
	 * Create a session that immediately emits an error result and closes.
	 * Used when errors occur during session creation.
	 */
	private static createErrorSession<Format extends "string" | "bytes">(
		error: S2Error,
	): FetchReadSession<Format> {
		// Create a custom instance that extends ReadableStream and emits error immediately
		const stream = new ReadableStream<ReadResult<Format>>({
			start(controller) {
				controller.enqueue({ ok: false, error });
				controller.close();
			},
		});

		// Copy methods from stream to create a proper FetchReadSession
		const session = Object.assign(
			Object.create(FetchReadSession.prototype),
			stream,
		);
		session._nextReadPosition = undefined;
		session._lastObservedTail = undefined;

		return session as FetchReadSession<Format>;
	}

	private _nextReadPosition: StreamPosition | undefined = undefined;
	private _lastObservedTail: StreamPosition | undefined = undefined;

	private constructor(stream: ReadableStream<Uint8Array>, format: Format) {
		// Track error from parser
		let parserError: S2Error | null = null;

		// Track last ping time for timeout detection (20s without a ping = timeout)
		let lastPingTimeMs = performance.now();
		const PING_TIMEOUT_MS = 20000; // 20 seconds

		// Create EventStream that parses SSE and yields records
		const eventStream = new EventStream<ReadRecord<Format>>(stream, (msg) => {
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
					this._lastObservedTail = batch.tail;
				}
				let lastRecord = batch.records?.at(-1);
				if (lastRecord) {
					this._nextReadPosition = {
						seq_num: lastRecord.seq_num + 1,
						timestamp: lastRecord.timestamp,
					};
				}
				return { done: false, batch: true, value: batch.records ?? [] };
			}
			if (msg.event === "error") {
				// Store error and signal end of stream
				// SSE error events are server errors - treat as 503 (Service Unavailable) for retry logic
				debug("parse event error");
				parserError = new S2Error({
					message: msg.data ?? "Unknown error",
					status: 503,
				});
				return { done: true };
			}
			lastPingTimeMs = performance.now();

			// Skip ping events and other events
			return { done: false };
		});

		// Wrap the EventStream to convert records to ReadResult and check for errors
		const reader = eventStream.getReader();
		let done = false;

		super({
			pull: async (controller) => {
				if (done) {
					controller.close();
					return;
				}

				// Check for ping timeout before reading
				const now = performance.now();
				const timeSinceLastPingMs = now - lastPingTimeMs;
				if (timeSinceLastPingMs > PING_TIMEOUT_MS) {
					const timeoutError = new S2Error({
						message: `No ping received for ${Math.floor(timeSinceLastPingMs / 1000)}s (timeout: ${PING_TIMEOUT_MS / 1000}s)`,
						status: 408, // Request Timeout
						code: "TIMEOUT",
					});
					debug("ping timeout detected, elapsed=%dms", timeSinceLastPingMs);
					controller.enqueue({ ok: false, error: timeoutError });
					done = true;
					controller.close();
					return;
				}

				try {
					// Calculate remaining time until timeout
					const remainingTimeMs = PING_TIMEOUT_MS - timeSinceLastPingMs;

					// Race reader.read() against timeout
					// This ensures we don't wait forever if server stops sending events
					const result = await Promise.race([
						reader.read(),
						new Promise<{ done: true; value: undefined }>((_, reject) =>
							setTimeout(() => {
								const elapsed = performance.now() - lastPingTimeMs;
								reject(
									new S2Error({
										message: `No ping received for ${Math.floor(elapsed / 1000)}s (timeout: ${PING_TIMEOUT_MS / 1000}s)`,
										status: 408,
										code: "TIMEOUT",
									}),
								);
							}, remainingTimeMs),
						),
					]);

					if (result.done) {
						done = true;
						// Check if stream ended due to error
						if (parserError) {
							controller.enqueue({ ok: false, error: parserError });
						}
						controller.close();
					} else {
						// Emit successful result
						controller.enqueue({ ok: true, value: result.value });
					}
				} catch (error) {
					// Convert unexpected errors to S2Error and emit as error result
					const s2Err =
						error instanceof S2Error
							? error
							: new S2Error({ message: String(error), status: 500 });
					controller.enqueue({ ok: false, error: s2Err });
					done = true;
					controller.close();
				}
			},
			cancel: async () => {
				await eventStream.cancel();
			},
		});
	}

	public nextReadPosition(): StreamPosition | undefined {
		return this._nextReadPosition;
	}

	public lastObservedTail(): StreamPosition | undefined {
		return this._lastObservedTail;
	}

	// Implement AsyncIterable (for await...of support)
	[Symbol.asyncIterator](): AsyncIterableIterator<ReadResult<Format>> {
		const fn = (ReadableStream.prototype as any)[Symbol.asyncIterator];
		if (typeof fn === "function") return fn.call(this);
		const reader = this.getReader();
		return {
			next: async () => {
				const r = await reader.read();
				if (r.done) return { done: true, value: undefined };
				return { done: false, value: r.value };
			},
			return: async (value?: any) => {
				reader.releaseLock();
				return { done: true, value };
			},
			throw: async (e?: any) => {
				reader.releaseLock();
				throw e;
			},
			[Symbol.asyncIterator]() {
				return this;
			},
		};
	}

	// Implement AsyncDisposable
	async [Symbol.asyncDispose](): Promise<void> {
		await this.cancel();
	}
}

// Removed AcksStream - transport sessions no longer expose streams

/**
 * "Dumb" transport session for appending records via HTTP/1.1.
 * Queues append requests and ensures only one is in-flight at a time (single-flight).
 * No backpressure, no retry logic, no streams - just submit/close with value-encoded errors.
 */
export class FetchAppendSession {
	private queue: Array<{
		records: AppendRecord[];
		fencing_token?: string;
		match_seq_num?: number;
		meteredSize: number;
	}> = [];
	private pendingResolvers: Array<{
		resolve: (result: AppendResult) => void;
	}> = [];
	private inFlight = false;
	private readonly options?: S2RequestOptions;
	private readonly stream: string;
	private closed = false;
	private processingPromise: Promise<void> | null = null;
	private readonly client: Client;

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
		this.client = createClient(
			createConfig({
				baseUrl: transportConfig.baseUrl,
				auth: () => Redacted.value(transportConfig.accessToken),
				headers: transportConfig.basinName
					? { "s2-basin": transportConfig.basinName }
					: {},
			}),
		);
	}

	/**
	 * Close the append session.
	 * Waits for all pending appends to complete before resolving.
	 * Never throws - returns CloseResult.
	 */
	async close(): Promise<CloseResult> {
		try {
			this.closed = true;
			await this.waitForDrain();
			return okClose();
		} catch (error) {
			const s2Err =
				error instanceof S2Error
					? error
					: new S2Error({ message: String(error), status: 500 });
			return errClose(s2Err);
		}
	}

	/**
	 * Submit an append request to the session.
	 * The request will be queued and sent when no other request is in-flight.
	 * Never throws - returns AppendResult discriminated union.
	 */
	submit(
		records: AppendRecord | AppendRecord[],
		args?: {
			fencing_token?: string;
			match_seq_num?: number;
			precalculatedSize?: number;
		},
		precalculatedSize?: number,
	): Promise<AppendResult> {
		// Validate closed state
		if (this.closed) {
			return Promise.resolve(
				err(new S2Error({ message: "AppendSession is closed", status: 400 })),
			);
		}

		const recordsArray = Array.isArray(records) ? records : [records];

		// Validate batch size limits (non-retryable 400-level error)
		if (recordsArray.length > 1000) {
			return Promise.resolve(
				err(
					new S2Error({
						message: `Batch of ${recordsArray.length} exceeds maximum batch size of 1000 records`,
						status: 400,
						code: "INVALID_ARGUMENT",
					}),
				),
			);
		}

		// Validate metered size (use precalculated if provided)
		let batchMeteredSize = precalculatedSize ?? args?.precalculatedSize ?? 0;
		if (batchMeteredSize === 0) {
			for (const record of recordsArray) {
				batchMeteredSize += meteredSizeBytes(record);
			}
		}

		if (batchMeteredSize > 1024 * 1024) {
			return Promise.resolve(
				err(
					new S2Error({
						message: `Batch size ${batchMeteredSize} bytes exceeds maximum of 1 MiB (1048576 bytes)`,
						status: 400,
						code: "INVALID_ARGUMENT",
					}),
				),
			);
		}

		return new Promise((resolve) => {
			this.queue.push({
				records: recordsArray,
				fencing_token: args?.fencing_token,
				match_seq_num: args?.match_seq_num,
				meteredSize: batchMeteredSize,
			});
			this.pendingResolvers.push({ resolve });

			// Start processing if not already running
			if (!this.processingPromise) {
				// Attach a catch to avoid unhandled rejection warnings on hard failures
				this.processingPromise = this.processLoop().catch(() => {});
			}
		});
	}

	/**
	 * Main processing loop that sends queued requests one at a time.
	 * Single-flight: only one request in progress at a time.
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

				// Resolve with success result
				resolver.resolve(ok(ack));
			} catch (error) {
				// Convert error to S2Error and resolve with error result
				const s2Err =
					error instanceof S2Error
						? error
						: new S2Error({ message: String(error), status: 502 });

				// Resolve this request with error
				resolver.resolve(err(s2Err));

				// Resolve all remaining pending promises with the same error
				// (transport failure affects all queued requests)
				for (const pendingResolver of this.pendingResolvers) {
					pendingResolver.resolve(err(s2Err));
				}
				this.pendingResolvers = [];

				// Clear the queue
				this.queue = [];

				this.inFlight = false;
				this.processingPromise = null;
				return;
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
		// Fetch transport intentionally enforces single-flight submission (HTTP/1.1)
		// This ensures only one batch is in-flight at a time, regardless of user setting.
		const opts = {
			...sessionOptions,
			maxInflightBatches: 1,
		} as AppendSessionOptions;
		return AppendSessionImpl.create(
			(myOptions) => {
				return FetchAppendSession.create(
					stream,
					this.transportConfig,
					myOptions,
					requestOptions,
				);
			},
			opts,
			this.transportConfig.retry,
		);
	}

	async makeReadSession<Format extends "string" | "bytes" = "string">(
		stream: string,
		args?: ReadArgs<Format>,
		options?: S2RequestOptions,
	): Promise<ReadSession<Format>> {
		return ReadSessionImpl.create(
			(myArgs) => {
				return FetchReadSession.create(this.client, stream, myArgs, options);
			},
			args,
			this.transportConfig.retry,
		);
	}
}
