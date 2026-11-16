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
	sessionClosedError,
} from "../../../../error.js";
import type { Client } from "../../../../generated/client/index.js";
import type * as API from "../../../../generated/index.js";
import { read } from "../../../../generated/index.js";
import { fromAPIStreamPosition } from "../../../../internal/mappers.js";
import type * as Types from "../../../../types.js";
import { computeAppendRecordFormat } from "../../../../utils.js";
import { decodeFromBase64 } from "../../../base64.js";
import { createApiClient } from "../../../client.js";
import { S2_ENCRYPTION_KEY_HEADER } from "../../../encryption.js";
import { EventStream } from "../../../event-stream.js";
import { FifoQueue } from "../../../queue.js";
import * as Redacted from "../../../redacted.js";
import type { AppendResult, CloseResult } from "../../../result.js";
import { err, errClose, ok, okClose } from "../../../result.js";
import {
	RetryAppendSession as AppendSessionImpl,
	RetryReadSession as ReadSessionImpl,
} from "../../../retry.js";
import { streamConfigHeaders } from "../../../stream-config.js";
import { OpenSessions } from "../../open-sessions.js";
import { canSetUserAgentHeader, DEFAULT_USER_AGENT } from "../../runtime.js";
import type {
	AppendRecord,
	AppendSession,
	AppendSessionOptions,
	ReadArgs,
	ReadBatch,
	ReadRecord,
	ReadSession,
	SessionTransport,
	TransportAppendSession,
	TransportConfig,
	TransportReadEvent,
	TransportReadSession,
} from "../../types.js";
import { streamAppend } from "./shared.js";

const debug = createDebug("s2:fetch");

export class FetchReadSession<Format extends "string" | "bytes" = "string">
	extends ReadableStream<TransportReadEvent<Format>>
	implements TransportReadSession<Format>
{
	static async create<Format extends "string" | "bytes" = "string">(
		client: Client,
		name: string,
		args?: ReadArgs<Format>,
		options?: S2RequestOptions,
	) {
		debug("FetchReadSession.create stream=%s args=%o", name, args);
		const { as, ignore_command_records, stream_config, ...queryParams } =
			args ?? {};

		const response = await read({
			client,
			path: {
				stream: name,
			},
			headers: {
				accept: "text/event-stream",
				...(as === "bytes" ? { "s2-format": "base64" } : {}),
				...streamConfigHeaders(stream_config),
			},
			query: queryParams,
			parseAs: "stream",
			...options,
		});
		if (response.error) {
			// Convert error to S2Error and throw - let caller handle connection errors
			const status = response.response.status;
			if (status === 416) {
				const err =
					typeof response.error === "object" && response.error !== null
						? (response.error as {
								code?: string;
								tail?: API.StreamPosition;
							})
						: undefined;
				throw new RangeNotSatisfiableError({
					status,
					code: err?.code,
					tail: err?.tail ? fromAPIStreamPosition(err.tail) : undefined,
				});
			}
			const error =
				typeof response.error === "object" &&
				response.error !== null &&
				"message" in response.error
					? new S2Error({
							message: response.error.message,
							code: response.error.code ?? undefined,
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

	/** @internal */
	static _createForTesting<Format extends "string" | "bytes" = "string">(
		stream: ReadableStream<Uint8Array>,
		format: Format,
	): FetchReadSession<Format> {
		return new FetchReadSession(stream, format);
	}

	private _lastObservedTail: API.StreamPosition | undefined = undefined;

	private constructor(stream: ReadableStream<Uint8Array>, format: Format) {
		let parserError: S2Error | null = null;

		// Heartbeats can be 15 seconds apart. Allow 10 seconds for delays.
		let lastPingTimeMs = performance.now();
		const PING_TIMEOUT_MS = 25000;

		const eventStream = new EventStream<TransportReadEvent<Format>>(
			stream,
			(msg) => {
				// Any event confirms the stream is active.
				lastPingTimeMs = performance.now();

				if (msg.event === "batch" && msg.data) {
					const rawBatch: API.ReadBatch = JSON.parse(msg.data);
					const batch = (() => {
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
									headers: record.headers || undefined,
								})),
							} satisfies ReadBatch<"string">;
						}
					})() as ReadBatch<Format>;
					if (batch.tail) {
						this._lastObservedTail = batch.tail;
					}
					return { done: false, value: { ok: true, batch } };
				}
				if (msg.event === "error") {
					// Treat server error events as retryable.
					debug("parse event error");
					parserError = new S2Error({
						message: msg.data ?? "Unknown error",
						status: 503,
					});
					return { done: true };
				}
				if (msg.event === "ping") {
					debug("ping");
					if (msg.data) {
						try {
							const ping: { tail?: API.StreamPosition } = JSON.parse(msg.data);
							if (ping.tail) {
								this._lastObservedTail = ping.tail;
								return {
									done: false,
									value: {
										ok: true,
										batch: { records: [], tail: ping.tail },
									},
								};
							}
						} catch {}
					}
				}

				// Skip ping events and other events
				return { done: false };
			},
		);

		// Normalize stream failures as transport events.
		const reader = eventStream.getReader();
		const cancelReader = async (reason?: unknown) => {
			try {
				await reader.cancel(reason);
			} catch {}
		};
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

					// Capture current ping time to detect if activity happens during timeout
					const capturedLastPingTime = lastPingTimeMs;
					const remainingTimeMs =
						PING_TIMEOUT_MS - (performance.now() - lastPingTimeMs);

					// Reuse pending read if it exists (from previous stale timeout iteration)
					if (!pendingRead) {
						pendingRead = reader.read();
					}
					const currentRead = pendingRead;

					let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
					try {
						// Race reader.read() against timeout
						// If timeout fires but activity happened since scheduling, it's "stale" and we retry
						const result: RaceResult = await Promise.race([
							currentRead.then((r) => {
								pendingRead = null;
								return { type: "data" as const, value: r };
							}),
							new Promise<RaceResult>((resolve) => {
								timeoutHandle = setTimeout(() => {
									if (lastPingTimeMs === capturedLastPingTime) {
										// No activity since timeout was scheduled - actually timed out
										debug("read session ping timeout");
										resolve({ type: "timeout" });
									} else {
										// Activity happened - this timeout is stale, retry with new timeout.
										resolve({ type: "stale" });
									}
								}, remainingTimeMs);
							}),
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
							debug(
								"read session timeout elapsed_ms=%d timeout_ms=%d status=%d code=%s",
								Math.floor(elapsed),
								PING_TIMEOUT_MS,
								timeoutError.status,
								timeoutError.code,
							);
							controller.enqueue({ ok: false, error: timeoutError });
							done = true;
							await cancelReader(timeoutError);
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
							controller.enqueue(result.value.value);
						}
						return;
					} catch (error) {
						// Convert unexpected errors to S2Error and emit as error result
						const readError = s2Error(error);
						debug(
							"read session body error status=%d code=%s origin=%s message=%s",
							readError.status,
							readError.code,
							readError.origin,
							readError.message,
						);
						controller.enqueue({ ok: false, error: readError });
						done = true;
						await cancelReader(error);
						controller.close();
						return;
					} finally {
						if (timeoutHandle) clearTimeout(timeoutHandle);
					}
				}
			},
			cancel: async () => {
				await cancelReader("cancelled");
			},
		});
	}

	public lastObservedTail(): API.StreamPosition | undefined {
		return this._lastObservedTail;
	}

	// Implement AsyncIterable (for await...of support)
	[Symbol.asyncIterator](): AsyncIterableIterator<TransportReadEvent<Format>> {
		const proto = ReadableStream.prototype as ReadableStreamWithAsyncIterator<
			TransportReadEvent<Format>
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
				try {
					await reader.cancel();
				} catch (err: any) {
					if (err?.code !== "ERR_INVALID_STATE") throw err;
				}
				reader.releaseLock();
				return { done: true, value };
			},
			throw: async (e?: any) => {
				try {
					await reader.cancel(e);
				} catch (err: any) {
					if (err?.code !== "ERR_INVALID_STATE") throw err;
				}
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
	// Appends waiting to be sent, one at a time.
	private readonly pending = new FifoQueue<{
		input: Types.AppendInput;
		resolve: (result: AppendResult) => void;
		onSend?: () => void;
	}>();
	private readonly stream: string;
	private closed = false;
	private processingPromise: Promise<void> | null = null;
	private readonly client: Client;
	// Cancels in-flight appends on close().
	private readonly abortController = new AbortController();

	static async create(
		stream: string,
		transportConfig: TransportConfig,
		sessionOptions?: AppendSessionOptions,
	): Promise<FetchAppendSession> {
		return new FetchAppendSession(stream, transportConfig, sessionOptions);
	}

	private constructor(
		stream: string,
		transportConfig: TransportConfig,
		sessionOptions?: AppendSessionOptions,
	) {
		this.stream = stream;
		debug("[%s] FetchAppendSession created", stream);
		const headers: Record<string, string> = {};
		if (transportConfig.basinName) {
			headers["s2-basin"] = transportConfig.basinName;
		}
		if (transportConfig.encryptionKey) {
			headers[S2_ENCRYPTION_KEY_HEADER] = Redacted.value(
				transportConfig.encryptionKey,
			);
		}
		Object.assign(headers, streamConfigHeaders(sessionOptions?.streamConfig));
		if (canSetUserAgentHeader()) {
			headers["user-agent"] = DEFAULT_USER_AGENT;
		}
		this.client = createApiClient(
			transportConfig.baseUrl,
			() => Redacted.value(transportConfig.accessToken),
			headers,
		);
	}

	/**
	 * Close the append session.
	 * Cancels any in-flight append and fails queued ones, rather than waiting
	 * for them: the retry layer closes a session either once every append is
	 * acknowledged, or to abandon a stalled attempt.
	 * Never throws - returns CloseResult.
	 */
	async close(): Promise<CloseResult> {
		debug("[%s] FetchAppendSession close requested", this.stream);
		try {
			this.closed = true;
			// Fails the append in flight; the loop then fails the queued ones.
			this.abortController.abort();
			await this.processingPromise;
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
	submit(input: Types.AppendInput, onSend?: () => void): Promise<AppendResult> {
		debug(
			"[%s] FetchAppendSession.submit: records=%d, match_seq_num=%s, queueLen=%d",
			this.stream,
			input.records.length,
			input.matchSeqNum ?? "none",
			this.pending.length,
		);

		// Validate closed state
		if (this.closed) {
			debug(
				"[%s] FetchAppendSession.submit: session closed, rejecting",
				this.stream,
			);
			return Promise.resolve(err(sessionClosedError()));
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
			this.pending.push({ input, resolve, onSend });
			debug(
				"[%s] FetchAppendSession.submit: queued, queueLen=%d",
				this.stream,
				this.pending.length,
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
		while (this.pending.length > 0) {
			// Once closed, send nothing more.
			if (this.closed) {
				for (const queued of this.pending) {
					queued.resolve(err(sessionClosedError()));
				}
				this.pending.clear();
				break;
			}
			const { input, resolve, onSend } = this.pending.shift()!;

			debug(
				"[%s] FetchAppendSession.processLoop: sending %d records, match_seq_num=%s",
				this.stream,
				input.records.length,
				input.matchSeqNum ?? "none",
			);

			// Data is about to enter the network
			onSend?.();

			try {
				const preferProtobuf = input.records.some(
					(record) => computeAppendRecordFormat(record) === "bytes",
				);
				const appendOptions = {
					signal: this.abortController.signal,
					preferProtobuf,
				};

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
				resolve(ok(ack));
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
				resolve(err(s2Err));

				// Resolve all remaining pending promises with the same error
				// (transport failure affects all queued requests)
				debug(
					"[%s] FetchAppendSession.processLoop: failing %d queued requests",
					this.stream,
					this.pending.length,
				);
				for (const queued of this.pending) {
					queued.resolve(err(s2Err));
				}
				this.pending.clear();

				this.processingPromise = null;
				return;
			}
		}

		debug("[%s] FetchAppendSession.processLoop: done", this.stream);
		this.processingPromise = null;
	}
}

/**
 * Fetch-based transport using HTTP/1.1 + JSON
 * Works in all JavaScript environments (browser, Node.js, Bun, etc.)
 */
export class FetchTransport implements SessionTransport {
	private readonly client: Client;
	private readonly transportConfig: TransportConfig;
	private readonly sessions = new OpenSessions();
	constructor(config: TransportConfig) {
		const headers: Record<string, string> = {};
		if (config.basinName) {
			headers["s2-basin"] = config.basinName;
		}
		if (config.encryptionKey) {
			headers[S2_ENCRYPTION_KEY_HEADER] = Redacted.value(config.encryptionKey);
		}
		if (canSetUserAgentHeader()) {
			headers["user-agent"] = DEFAULT_USER_AGENT;
		}
		this.client = createApiClient(
			config.baseUrl,
			() => Redacted.value(config.accessToken),
			headers,
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
				);
			},
			sessionOptions,
			this.transportConfig.retry,
			stream, // Pass stream name for debug context
			{ signal: requestOptions?.signal, sessions: this.sessions },
		);
	}

	async makeReadSession<Format extends "string" | "bytes" = "string">(
		stream: string,
		args?: ReadArgs<Format>,
		options?: S2RequestOptions,
	): Promise<ReadSession<Format>> {
		return ReadSessionImpl.create(
			(myArgs, signal) => {
				return FetchReadSession.create(this.client, stream, myArgs, {
					...options,
					signal,
				});
			},
			args,
			this.transportConfig.retry,
			{ signal: options?.signal, sessions: this.sessions },
		);
	}

	/** End the sessions opened from this transport. */
	async close(): Promise<void> {
		await this.sessions.closeAll();
	}
}
