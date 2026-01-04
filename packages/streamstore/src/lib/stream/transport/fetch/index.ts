import createDebug from "debug";

/** Type for ReadableStream with optional async iterator support. */
type ReadableStreamWithAsyncIterator<T> = ReadableStream<T> & {
	[Symbol.asyncIterator]?: () => AsyncIterableIterator<T>;
};

import type { S2RequestOptions } from "../../../../common.js";
import {
	RangeNotSatisfiableError,
	S2Error,
	s2Error,
} from "../../../../error.js";
import {
	type Client,
	createClient,
	createConfig,
} from "../../../../generated/client/index.js";
import type * as API from "../../../../generated/index.js";
import { read } from "../../../../generated/index.js";
import type * as Types from "../../../../types.js";
import { computeAppendRecordFormat } from "../../../../utils.js";
import { decodeFromBase64 } from "../../../base64.js";
import { EventStream } from "../../../event-stream.js";
import * as Redacted from "../../../redacted.js";
import type { AppendResult, CloseResult } from "../../../result.js";
import { err, errClose, ok, okClose } from "../../../result.js";
import {
	RetryAppendSession as AppendSessionImpl,
	RetryReadSession as ReadSessionImpl,
} from "../../../retry.js";
import { canSetUserAgentHeader, DEFAULT_USER_AGENT } from "../../runtime.js";
import type {
	AppendRecord,
	AppendSession,
	AppendSessionOptions,
	ReadArgs,
	ReadBatch,
	ReadRecord,
	ReadResult,
	ReadSession,
	SessionTransport,
	TransportAppendSession,
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
			// Convert error to S2Error and throw - let caller handle connection errors
			const status = response.response.status;
			const error =
				"message" in response.error
					? new S2Error({
							message: response.error.message,
							code: response.error.code ?? undefined,
							status,
						})
					: status === 416
						? new RangeNotSatisfiableError({
								status,
							})
						: new S2Error({
								message: response.response.statusText ?? "Request failed",
								status,
							});
			throw error;
		}
		if (!response.response.body) {
			throw new S2Error({
				message: "No body in SSE response",
				code: "INVALID_RESPONSE",
				status: 502,
				origin: "sdk",
			});
		}
		const format = (args?.as ?? "string") as Format;
		return new FetchReadSession(response.response.body, format);
	}

	private _nextReadPosition: API.StreamPosition | undefined = undefined;
	private _lastObservedTail: API.StreamPosition | undefined = undefined;

	private constructor(stream: ReadableStream<Uint8Array>, format: Format) {
		// Track error from parser
		let parserError: S2Error | null = null;

		// Track last ping time for timeout detection (20s without a ping = timeout)
		let lastPingTimeMs = performance.now();
		const PING_TIMEOUT_MS = 20000; // 20 seconds

		// Create EventStream that parses SSE and yields records
		const eventStream = new EventStream<ReadRecord<Format>>(stream, (msg) => {
			// Update ping time on ANY event from the server
			lastPingTimeMs = performance.now();

			// Parse SSE events according to the S2 protocol
			if (msg.event === "batch" && msg.data) {
				const rawBatch: API.ReadBatch = JSON.parse(msg.data);
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
			if (msg.event === "ping") {
				debug("ping");
			}

			// Skip ping events and other events
			return { done: false };
		});

		// Wrap the EventStream to convert records to ReadResult and check for errors
		const reader = eventStream.getReader();
		let done = false;
		// Track pending read to reuse across timeout retries
		type ReaderResult = Awaited<ReturnType<typeof reader.read>>;
		let pendingRead: Promise<ReaderResult> | null = null;

		// Result type for Promise.race
		type RaceResult =
			| { type: "data"; value: ReaderResult }
			| { type: "timeout" }
			| { type: "stale" };

		super({
			pull: async (controller) => {
				// Loop to retry when stale timeouts fire
				while (true) {
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
						await reader.cancel();
						controller.close();
						return;
					}

					// Capture current ping time to detect if activity happens during timeout
					const capturedLastPingTime = lastPingTimeMs;
					const remainingTimeMs = PING_TIMEOUT_MS - timeSinceLastPingMs;

					// Reuse pending read if it exists (from previous stale timeout iteration)
					if (!pendingRead) {
						pendingRead = reader.read();
					}
					const currentRead = pendingRead;

					try {
						// Race reader.read() against timeout
						// If timeout fires but activity happened since scheduling, it's "stale" and we retry
						const result: RaceResult = await Promise.race([
							currentRead.then((r) => {
								pendingRead = null;
								return { type: "data" as const, value: r };
							}),
							new Promise<RaceResult>((resolve) =>
								setTimeout(() => {
									if (lastPingTimeMs === capturedLastPingTime) {
										// No activity since timeout was scheduled - actually timed out
										debug("read session ping timeout");
										resolve({ type: "timeout" });
									} else {
										// Activity happened - this timeout is stale, retry with new timeout
										debug("stale timeout, activity detected, retrying");
										resolve({ type: "stale" });
									}
								}, remainingTimeMs),
							),
						]);

						if (result.type === "stale") {
							// Loop to create new timeout, reusing pendingRead
							continue;
						}

						if (result.type === "timeout") {
							const elapsed = performance.now() - lastPingTimeMs;
							const timeoutError = new S2Error({
								message: `No ping received for ${Math.floor(elapsed / 1000)}s (timeout: ${PING_TIMEOUT_MS / 1000}s)`,
								status: 408,
								code: "TIMEOUT",
							});
							controller.enqueue({ ok: false, error: timeoutError });
							done = true;
							await reader.cancel();
							controller.close();
							return;
						}

						// Got data
						if (result.value.done) {
							done = true;
							// Check if stream ended due to error
							if (parserError) {
								controller.enqueue({ ok: false, error: parserError });
							}
							controller.close();
						} else {
							// Emit successful result
							controller.enqueue({ ok: true, value: result.value.value });
						}
						return;
					} catch (error) {
						// Convert unexpected errors to S2Error and emit as error result
						controller.enqueue({ ok: false, error: s2Error(error) });
						done = true;
						await reader.cancel();
						controller.close();
						return;
					}
				}
			},
			cancel: async () => {
				await reader.cancel();
			},
		});
	}

	public nextReadPosition(): API.StreamPosition | undefined {
		return this._nextReadPosition;
	}

	public lastObservedTail(): API.StreamPosition | undefined {
		return this._lastObservedTail;
	}

	// Implement AsyncIterable (for await...of support)
	[Symbol.asyncIterator](): AsyncIterableIterator<ReadResult<Format>> {
		const proto = ReadableStream.prototype as ReadableStreamWithAsyncIterator<
			ReadResult<Format>
		>;
		const fn = proto[Symbol.asyncIterator];
		if (typeof fn === "function") {
			try {
				return fn.call(this);
			} catch {
				// Native method may throw "Illegal invocation" when called on subclass
				// Fall through to manual implementation
			}
		}
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
 * Fetch-based transport session for appending records via HTTP/1.1.
 * Queues append requests and ensures only one is in-flight at a time (single-flight).
 * No backpressure, no retry logic, no streams - just submit/close with value-encoded errors.
 */
export class FetchAppendSession implements TransportAppendSession {
	private queue: Array<Types.AppendInput> = [];
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
		debug("[%s] FetchAppendSession created", stream);
		const headers: Record<string, string> = {};
		if (transportConfig.basinName) {
			headers["s2-basin"] = transportConfig.basinName;
		}
		if (canSetUserAgentHeader()) {
			headers["user-agent"] = DEFAULT_USER_AGENT;
		}
		this.client = createClient(
			createConfig({
				baseUrl: transportConfig.baseUrl,
				auth: () => Redacted.value(transportConfig.accessToken),
				headers: headers,
			}),
		);
	}

	/**
	 * Close the append session.
	 * Waits for all pending appends to complete before resolving.
	 * Never throws - returns CloseResult.
	 */
	async close(): Promise<CloseResult> {
		debug("[%s] FetchAppendSession close requested", this.stream);
		try {
			this.closed = true;
			await this.waitForDrain();
			debug("[%s] FetchAppendSession close complete", this.stream);
			return okClose();
		} catch (error) {
			const s2Err = s2Error(error);
			debug(
				"[%s] FetchAppendSession close error: %s",
				this.stream,
				s2Err.message,
			);
			return errClose(s2Err);
		}
	}

	/**
	 * Submit an append request to the session.
	 * The request will be queued and sent when no other request is in-flight.
	 * Never throws - returns AppendResult discriminated union.
	 */
	submit(input: Types.AppendInput): Promise<AppendResult> {
		debug(
			"[%s] FetchAppendSession.submit: records=%d, match_seq_num=%s, queueLen=%d",
			this.stream,
			input.records.length,
			input.matchSeqNum ?? "none",
			this.queue.length,
		);

		// Validate closed state
		if (this.closed) {
			debug(
				"[%s] FetchAppendSession.submit: session closed, rejecting",
				this.stream,
			);
			return Promise.resolve(
				err(new S2Error({ message: "AppendSession is closed", status: 400 })),
			);
		}

		// Validate batch size limits (non-retryable 400-level error)
		// Note: This should already be validated by AppendInput.create(), but we check defensively
		if (input.records.length > 1000) {
			debug(
				"[%s] FetchAppendSession.submit: batch too large (%d records)",
				this.stream,
				input.records.length,
			);
			return Promise.resolve(
				err(
					new S2Error({
						message: `Batch of ${input.records.length} exceeds maximum batch size of 1000 records`,
						status: 400,
						code: "INVALID_ARGUMENT",
					}),
				),
			);
		}

		// Validate metered size (use cached value from AppendInput)
		const batchMeteredSize = input.meteredBytes;

		if (batchMeteredSize > 1024 * 1024) {
			debug(
				"[%s] FetchAppendSession.submit: batch too large (%d bytes)",
				this.stream,
				batchMeteredSize,
			);
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
			this.queue.push(input);
			this.pendingResolvers.push({ resolve });
			debug(
				"[%s] FetchAppendSession.submit: queued, queueLen=%d",
				this.stream,
				this.queue.length,
			);

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
		debug("[%s] FetchAppendSession.processLoop: starting", this.stream);
		while (this.queue.length > 0) {
			this.inFlight = true;
			const input = this.queue.shift()!;
			const resolver = this.pendingResolvers.shift()!;

			debug(
				"[%s] FetchAppendSession.processLoop: sending %d records, match_seq_num=%s",
				this.stream,
				input.records.length,
				input.matchSeqNum ?? "none",
			);

			try {
				const preferProtobuf = input.records.some(
					(record) => computeAppendRecordFormat(record) === "bytes",
				);
				const appendOptions = this.options
					? { ...this.options, preferProtobuf }
					: { preferProtobuf };

				const ack = await streamAppend(
					this.stream,
					this.client,
					input,
					appendOptions,
				);

				debug(
					"[%s] FetchAppendSession.processLoop: success, seq_num=%d-%d",
					this.stream,
					ack.start.seqNum,
					ack.end.seqNum,
				);

				// Resolve with success result
				resolver.resolve(ok(ack));
			} catch (error) {
				// Convert error to S2Error and resolve with error result
				const s2Err = s2Error(error);

				debug(
					"[%s] FetchAppendSession.processLoop: error, status=%s, message=%s",
					this.stream,
					s2Err.status,
					s2Err.message,
				);

				// Resolve this request with error
				resolver.resolve(err(s2Err));

				// Resolve all remaining pending promises with the same error
				// (transport failure affects all queued requests)
				debug(
					"[%s] FetchAppendSession.processLoop: failing %d queued requests",
					this.stream,
					this.pendingResolvers.length,
				);
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

		debug("[%s] FetchAppendSession.processLoop: done", this.stream);
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
		const headers: Record<string, string> = {};
		if (config.basinName) {
			headers["s2-basin"] = config.basinName;
		}
		if (canSetUserAgentHeader()) {
			headers["user-agent"] = DEFAULT_USER_AGENT;
		}
		this.client = createClient(
			createConfig({
				baseUrl: config.baseUrl,
				auth: () => Redacted.value(config.accessToken),
				headers: headers,
			}),
		);
		this.transportConfig = config;
	}

	async makeAppendSession(
		stream: string,
		sessionOptions?: AppendSessionOptions,
		requestOptions?: S2RequestOptions,
	): Promise<AppendSession> {
		return AppendSessionImpl.create(
			(myOptions) => {
				return FetchAppendSession.create(
					stream,
					this.transportConfig,
					myOptions,
					requestOptions,
				);
			},
			sessionOptions,
			this.transportConfig.retry,
			stream, // Pass stream name for debug context
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

	async close(): Promise<void> {
		// Fetch transport holds no long-lived resources beyond the client.
		// Provided for API symmetry; nothing to tear down.
	}
}
