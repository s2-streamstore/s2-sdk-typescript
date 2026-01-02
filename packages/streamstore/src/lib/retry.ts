import createDebug from "debug";
import type { RetryConfig } from "../common.js";
import {
	abortedError,
	invariantViolation,
	S2Error,
	s2Error,
	withS2Error,
} from "../error.js";
import type * as API from "../generated/index.js";
import * as Types from "../types.js";
import { meteredBytes } from "../utils.js";
import type { AppendResult, CloseResult } from "./result.js";
import { err, errClose, ok, okClose } from "./result.js";
import type {
	AcksStream,
	AppendRecord,
	AppendSessionOptions,
	AppendSession as AppendSessionType,
	ReadArgs,
	ReadRecord,
	ReadSession as ReadSessionType,
	TransportAppendSession,
	TransportReadSession,
} from "./stream/types.js";
import { BatchSubmitTicket } from "./stream/types.js";

const debugWith = createDebug("s2:retry:with");
const debugRead = createDebug("s2:retry:read");
const debugSession = createDebug("s2:retry:session");

/** Type guard for errors with a code property (e.g., Node.js errors). */
function hasErrorCode(err: unknown, code: string): boolean {
	return (
		typeof err === "object" &&
		err !== null &&
		"code" in err &&
		err.code === code
	);
}

/** Type for ReadableStream with optional async iterator support. */
type ReadableStreamWithAsyncIterator<T> = ReadableStream<T> & {
	[Symbol.asyncIterator]?: () => AsyncIterableIterator<T>;
};

/**
 * Convert generated StreamPosition to SDK StreamPosition.
 */
function toSDKStreamPosition(pos: API.StreamPosition): Types.StreamPosition {
	return {
		seqNum: pos.seq_num,
		timestamp: new Date(pos.timestamp),
	};
}

/**
 * Convert internal ReadRecord (with headers as object for strings) to SDK ReadRecord (with headers as array).
 */
function toSDKReadRecord<Format extends "string" | "bytes">(
	record: ReadRecord<Format>,
): Types.ReadRecord<Format> {
	if (
		record.headers &&
		typeof record.headers === "object" &&
		!Array.isArray(record.headers)
	) {
		// String format: headers is an object, convert to array of tuples
		const result: Types.ReadRecord<"string"> = {
			seqNum: record.seq_num,
			timestamp: new Date(record.timestamp),
			body: (record.body as string) ?? "",
			headers: Object.entries(record.headers as Record<string, string>),
		};
		return result as Types.ReadRecord<Format>;
	} else {
		// Bytes format: headers is already an array
		const result: Types.ReadRecord<"bytes"> = {
			seqNum: record.seq_num,
			timestamp: new Date(record.timestamp),
			body: (record.body as Uint8Array) ?? new Uint8Array(),
			headers: (record.headers as Array<[Uint8Array, Uint8Array]>) ?? [],
		};
		return result as Types.ReadRecord<Format>;
	}
}

/**
 * Default retry configuration.
 */
export const DEFAULT_RETRY_CONFIG: Required<RetryConfig> = {
	maxAttempts: 3,
	minDelayMillis: 100,
	maxDelayMillis: 1000,
	appendRetryPolicy: "all",
	requestTimeoutMillis: 5000, // 5 seconds
	connectionTimeoutMillis: 5000, // 5 seconds
};

const RETRYABLE_STATUS_CODES = new Set([
	408, // request_timeout
	429, // too_many_requests
	500, // internal_server_error
	502, // bad_gateway
	503, // service_unavailable
]);

/**
 * Determines if an error should be retried based on its characteristics.
 * 400-level errors (except 408, 429) are non-retryable validation/client errors.
 */
export function isRetryable(error: S2Error): boolean {
	if (!error.status) return false;

	// Explicit retryable codes (including some 4xx like 408, 429)
	if (RETRYABLE_STATUS_CODES.has(error.status)) {
		return true;
	}

	// 400-level errors are generally non-retryable (validation, bad request)
	if (error.status >= 400 && error.status < 500) {
		return false;
	}

	return false;
}

/**
 * Calculates the delay before the next retry attempt using exponential backoff
 * with additive jitter.
 *
 * Formula:
 *   baseDelay = min(minDelayMillis * 2^attempt, maxDelayMillis)
 *   jitter = random(0, baseDelay)
 *   delay = baseDelay + jitter
 *
 * @param attempt - Zero-based retry attempt number (0 = first retry)
 * @param minDelayMillis - Minimum delay for exponential backoff
 * @param maxDelayMillis - Maximum base delay (actual delay can be up to 2x with jitter)
 */
export function calculateDelay(
	attempt: number,
	minDelayMillis: number,
	maxDelayMillis: number,
): number {
	// Calculate exponential backoff: minDelay * 2^attempt, capped at maxDelay
	const baseDelay = Math.min(
		minDelayMillis * Math.pow(2, attempt),
		maxDelayMillis,
	);

	// Add jitter: random value in [0, baseDelay)
	const jitter = Math.random() * baseDelay;

	// Total delay is base + jitter
	return Math.floor(baseDelay + jitter);
}

/**
 * Sleeps for the specified duration.
 */
export function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Executes an async function with automatic retry logic for transient failures.
 *
 * @param retryConfig Retry configuration (max attempts, backoff duration)
 * @param fn The async function to execute
 * @returns The result of the function
 * @throws The last error if all retry attempts are exhausted
 */
export async function withRetries<T>(
	retryConfig: RetryConfig | undefined,
	fn: () => Promise<T>,
	isPolicyCompliant: (config: RetryConfig, error: S2Error) => boolean = () =>
		true,
): Promise<T> {
	const config = {
		...DEFAULT_RETRY_CONFIG,
		...retryConfig,
	};

	// Enforce minimum of 1 attempt (1 = no retries)
	if (config.maxAttempts < 1) config.maxAttempts = 1;

	let lastError: S2Error | undefined = undefined;

	// attemptNo is 1-based: 1..maxAttempts
	for (let attemptNo = 1; attemptNo <= config.maxAttempts; attemptNo++) {
		try {
			const result = await fn();
			if (attemptNo > 1) {
				debugWith("succeeded after %d retries", attemptNo - 1);
			}
			return result;
		} catch (error) {
			// withRetry only handles S2Errors (withS2Error should be called first)
			if (!(error instanceof S2Error)) {
				debugWith("non-S2Error thrown, rethrowing immediately: %s", error);
				throw error;
			}

			lastError = error;

			// Don't retry if this is the last attempt
			if (attemptNo === config.maxAttempts) {
				debugWith("max attempts exhausted, throwing error");
				break;
			}

			// Check if error is retryable
			if (!isPolicyCompliant(config, lastError) || !isRetryable(lastError)) {
				debugWith("error not retryable, throwing immediately");
				throw error;
			}

			// Calculate delay and wait before retrying
			const delay = calculateDelay(
				attemptNo - 1,
				config.minDelayMillis,
				config.maxDelayMillis,
			);
			debugWith(
				"retryable error, backing off for %dms, status=%s",
				delay,
				error.status,
			);
			await sleep(delay);
		}
	}

	throw lastError;
}
export class RetryReadSession<Format extends "string" | "bytes" = "string">
	extends ReadableStream<Types.ReadRecord<Format>>
	implements ReadSessionType<Format>
{
	private _nextReadPosition: API.StreamPosition | undefined = undefined;
	private _lastObservedTail: API.StreamPosition | undefined = undefined;

	private _recordsRead: number = 0;
	private _bytesRead: number = 0;

	static async create<Format extends "string" | "bytes" = "string">(
		generator: (
			args: ReadArgs<Format>,
		) => Promise<TransportReadSession<Format>>,
		args: ReadArgs<Format> = {},
		config?: RetryConfig,
	) {
		const retryConfig = {
			...DEFAULT_RETRY_CONFIG,
			...config,
		};

		// Establish connection eagerly to fail fast on connection errors
		// This way readSession() throws if we can't connect, rather than
		// returning a stream that immediately errors
		let attempt = 0;
		let lastError: S2Error | undefined;

		while (true) {
			try {
				const session = await generator(args);
				// Connection succeeded - return the retry wrapper
				return new RetryReadSession<Format>(args, generator, config, session);
			} catch (err) {
				const error = s2Error(err);
				lastError = error;

				const effectiveMax = Math.max(1, retryConfig.maxAttempts);
				if (isRetryable(error) && attempt < effectiveMax - 1) {
					const delay = calculateDelay(
						attempt,
						retryConfig.minDelayMillis,
						retryConfig.maxDelayMillis,
					);
					debugRead(
						"connection error in create, will retry after %dms, status=%s",
						delay,
						error.status,
					);
					await sleep(delay);
					attempt++;
					continue;
				}

				// Not retryable or attempts exhausted
				throw lastError;
			}
		}
	}

	private constructor(
		args: ReadArgs<Format>,
		generator: (
			args: ReadArgs<Format>,
		) => Promise<TransportReadSession<Format>>,
		config?: RetryConfig,
		initialSession?: TransportReadSession<Format>,
	) {
		const retryConfig = {
			...DEFAULT_RETRY_CONFIG,
			...config,
		};
		let session: TransportReadSession<Format> | undefined = initialSession;
		const startTimeMs = performance.now(); // Capture start time before super()
		super({
			start: async (controller) => {
				let nextArgs = { ...args } as ReadArgs<Format>;
				// Capture original request budget so retries compute from a stable baseline
				const baselineCount = args?.count;
				const baselineBytes = args?.bytes;
				const baselineWait = args?.wait;
				let attempt = 0;

				while (true) {
					// Use pre-established session on first iteration if provided
					if (!session) {
						debugRead("starting read session with args: %o", nextArgs);

						// Try to create session - may throw on connection errors
						try {
							session = await generator(nextArgs);
						} catch (err) {
							// Convert to S2Error if needed
							const error = s2Error(err);

							// Check if we can retry connection errors
							const effectiveMax = Math.max(1, retryConfig.maxAttempts);
							if (isRetryable(error) && attempt < effectiveMax - 1) {
								const delay = calculateDelay(
									attempt,
									retryConfig.minDelayMillis,
									retryConfig.maxDelayMillis,
								);
								debugRead(
									"connection error, will retry after %dms, status=%s",
									delay,
									error.status,
								);
								await sleep(delay);
								attempt++;
								continue; // Retry creating session
							}

							// Error is not retryable or attempts exhausted
							debugRead("connection error not retryable: %s", error);
							controller.error(error);
							return;
						}
					}

					const reader = session.getReader();

					while (true) {
						const { done, value: result } = await reader.read();
						// Update last observed tail if transport exposes it
						try {
							const tail = session.lastObservedTail?.();
							if (tail) this._lastObservedTail = tail;
						} catch {}
						if (done) {
							reader.releaseLock();
							controller.close();
							return;
						}

						// Check if result is an error
						if (!result.ok) {
							reader.releaseLock();
							const error = result.error;

							// Check if we can retry (track session attempts, not record reads)
							const effectiveMax = Math.max(1, retryConfig.maxAttempts);
							if (isRetryable(error) && attempt < effectiveMax - 1) {
								if (this._nextReadPosition) {
									nextArgs.seq_num = this._nextReadPosition.seq_num;
									// Clear alternative start position fields to avoid conflicting params
									delete nextArgs.timestamp;
									delete nextArgs.tail_offset;
								}
								// Compute planned backoff delay now so we can subtract it from wait budget
								const delay = calculateDelay(
									attempt,
									retryConfig.minDelayMillis,
									retryConfig.maxDelayMillis,
								);
								// Recompute remaining budget from original request each time to avoid double-subtraction
								if (baselineCount !== undefined) {
									nextArgs.count = Math.max(
										0,
										baselineCount - this._recordsRead,
									);
								}
								if (baselineBytes !== undefined) {
									nextArgs.bytes = Math.max(0, baselineBytes - this._bytesRead);
								}
								// Adjust wait from original budget based on total elapsed time since start
								if (baselineWait !== undefined) {
									const elapsedSeconds =
										(performance.now() - startTimeMs) / 1000;
									nextArgs.wait = Math.max(
										0,
										baselineWait - (elapsedSeconds + delay / 1000),
									);
								}
								// Proactively cancel the current transport session before retrying
								try {
									await session.cancel?.("retry");
								} catch {}

								// Clear session so a new one gets created on retry
								session = undefined;

								debugRead(
									"will retry after %dms, status=%s",
									delay,
									error.status,
								);
								await sleep(delay);
								attempt++;
								break; // Break inner loop to retry
							}

							// Error is not retryable or attempts exhausted
							debugRead("error in retry loop: %s", error);
							controller.error(error);
							return;
						}

						// Success: enqueue the record and reset retry attempt counter
						const record = result.value;
						this._nextReadPosition = {
							seq_num: record.seq_num + 1,
							timestamp: record.timestamp,
						};
						this._recordsRead++;
						this._bytesRead += meteredBytes(record);
						attempt = 0;

						controller.enqueue(toSDKReadRecord(record));
					}
				}
			},
			cancel: async (reason) => {
				try {
					await session?.cancel(reason);
				} catch (err) {
					// Ignore ERR_INVALID_STATE - stream may already be closed/cancelled
					if (!hasErrorCode(err, "ERR_INVALID_STATE")) {
						throw err;
					}
				}
			},
		});
	}

	async [Symbol.asyncDispose]() {
		await this.cancel("disposed");
	}

	// Polyfill for older browsers / Node.js environments
	[Symbol.asyncIterator](): AsyncIterableIterator<Types.ReadRecord<Format>> {
		const proto = ReadableStream.prototype as ReadableStreamWithAsyncIterator<
			Types.ReadRecord<Format>
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
				if (r.done) {
					reader.releaseLock();
					return { done: true, value: undefined };
				}
				return { done: false, value: r.value };
			},
			throw: async (e) => {
				try {
					await reader.cancel(e);
				} catch (err) {
					if (!hasErrorCode(err, "ERR_INVALID_STATE")) throw err;
				}
				reader.releaseLock();
				return { done: true, value: undefined };
			},
			return: async () => {
				try {
					await reader.cancel("done");
				} catch (err) {
					if (!hasErrorCode(err, "ERR_INVALID_STATE")) throw err;
				}
				reader.releaseLock();
				return { done: true, value: undefined };
			},
			[Symbol.asyncIterator]() {
				return this;
			},
		};
	}

	lastObservedTail(): Types.StreamPosition | undefined {
		return this._lastObservedTail
			? toSDKStreamPosition(this._lastObservedTail)
			: undefined;
	}

	nextReadPosition(): Types.StreamPosition | undefined {
		return this._nextReadPosition
			? toSDKStreamPosition(this._nextReadPosition)
			: undefined;
	}
}

/**
 * AppendSession wraps an underlying transport AppendSession with automatic retry logic.
 *
 * Architecture:
 * - All writes (submit() and writable.write()) are serialized through inflightQueue
 * - inflightQueue tracks batches that have been submitted but not yet acked
 * - Background ack reader consumes acks and matches them FIFO with inflightQueue
 * - On error, _initSession() recreates session and re-transmits all inflightQueue batches
 * - Ack timeout is fatal: if no ack arrives within the timeout window,
 *   the session aborts and rejects queued writers
 *
 * Flow for a successful append:
 * 1. submit(records) adds batch to inflightQueue with promise resolvers
 * 2. Calls underlying session.submit() to send batch
 * 3. Background reader receives ack, validates record count
 * 4. Resolves promise, removes from inflightQueue, forwards ack to user
 *
 * Flow for a failed append:
 * 1. submit(records) adds batch to inflightQueue
 * 2. Calls underlying session.submit() which fails
 * 3. Checks if retryable (status code, retry policy, idempotency)
 * 4. Calls _initSession() which closes old session, creates new session
 * 5. _initSession() re-transmits ALL batches in inflightQueue (recovery)
 * 6. Background reader receives acks for recovered batches
 * 7. Original submit() call's promise is resolved by background reader
 *
 * Invariants:
 * - Exactly one ack per batch in FIFO order
 * - Ack record count matches batch record count
 * - Acks arrive within requestTimeoutMillis or session is retried
 */
/**
 * New simplified inflight entry for the pump-based architecture.
 * Each entry tracks a batch and its promise from the inner transport session.
 */
type InflightEntry = {
	input: Types.AppendInput;
	expectedCount: number;
	attemptStartedMonotonicMs?: number; // Monotonic timestamp (performance.now) for per-attempt ack timeout anchoring
	innerPromise: Promise<AppendResult>; // Promise from transport session
	maybeResolve?: (result: AppendResult) => void; // Resolver for submit() callers
	needsSubmit?: boolean;
};

const DEFAULT_MAX_INFLIGHT_BYTES = 10 * 1024 * 1024; // 10 MiB default

type CapacityWaiter = {
	resolve: () => void;
	bytes: number;
	batches: number;
};

export class RetryAppendSession implements AsyncDisposable, AppendSessionType {
	private readonly requestTimeoutMillis: number;
	private readonly maxQueuedBytes: number;
	private readonly maxInflightBatches?: number;
	private readonly retryConfig: Required<RetryConfig> & {
		requestTimeoutMillis: number;
	};

	private readonly inflight: InflightEntry[] = [];
	private capacityWaiters: CapacityWaiter[] = []; // Queue of waiters for capacity

	private session?: TransportAppendSession;
	private queuedBytes = 0;
	private pendingBytes = 0;
	private pendingBatches = 0;
	private consecutiveFailures = 0;
	private currentAttempt = 0;

	private pumpPromise?: Promise<void>;
	private pumpStopped = false;
	private closing = false;
	private pumpWakeup?: () => void;
	private closed = false;
	private fatalError?: S2Error;

	private _lastAckedPosition?: Types.AppendAck;
	private acksController?: ReadableStreamDefaultController<Types.AppendAck>;

	public readonly readable: ReadableStream<Types.AppendAck>;
	public readonly writable: WritableStream<Types.AppendInput>;

	private readonly streamName: string;

	/**
	 * If the session has failed, returns the original fatal error that caused
	 * the pump to stop. Returns undefined when the session has not failed.
	 */
	failureCause(): S2Error | undefined {
		return this.fatalError;
	}

	constructor(
		private readonly generator: (
			options?: AppendSessionOptions,
		) => Promise<TransportAppendSession>,
		private readonly sessionOptions?: AppendSessionOptions,
		config?: RetryConfig,
		streamName?: string,
	) {
		this.streamName = streamName ?? "unknown";
		this.retryConfig = {
			...DEFAULT_RETRY_CONFIG,
			...config,
		};
		this.requestTimeoutMillis = this.retryConfig.requestTimeoutMillis;
		this.maxQueuedBytes =
			this.sessionOptions?.maxInflightBytes ?? DEFAULT_MAX_INFLIGHT_BYTES;
		this.maxInflightBatches = this.sessionOptions?.maxInflightBatches;

		this.readable = new ReadableStream<Types.AppendAck>({
			start: (controller) => {
				this.acksController = controller;
			},
		});

		this.writable = new WritableStream<Types.AppendInput>({
			write: async (chunk) => {
				if (this.closed || this.closing) {
					throw new S2Error({ message: "AppendSession is closed" });
				}

				// chunk is already AppendInput with meteredBytes computed
				// Reuse submit() to leverage shared backpressure/pump logic.
				const ticket = await this.submit(chunk);
				// Writable stream API only needs enqueue semantics, so drop ack but
				// suppress rejection noise (pump surfaces fatal errors elsewhere).
				ticket.ack().catch(() => {
					// Intentionally ignored.
				});
			},
			close: async () => {
				await this.close();
			},
			abort: async (reason) => {
				const error = abortedError(`AppendSession aborted: ${reason}`);
				await this.abort(error);
			},
		});
	}

	static async create(
		generator: (
			options?: AppendSessionOptions,
		) => Promise<TransportAppendSession>,
		sessionOptions?: AppendSessionOptions,
		config?: RetryConfig,
		streamName?: string,
	): Promise<RetryAppendSession> {
		return new RetryAppendSession(
			generator,
			sessionOptions,
			config,
			streamName,
		);
	}

	/**
	 * Wait for capacity to be available for the given batch size.
	 * Call this before submit() to apply backpressure based on maxInflightBatches/maxInflightBytes.
	 *
	 * @param bytes - Size in bytes (use meteredBytes() to calculate)
	 * @param numBatches - Number of batches (default: 1)
	 * @returns Promise that resolves when capacity is available
	 */
	async waitForCapacity(bytes: number, numBatches = 1): Promise<void> {
		debugSession(
			"[%s] [CAPACITY] checking for %d bytes, %d batches: queuedBytes=%d, pendingBytes=%d, maxQueuedBytes=%d, inflight=%d, pendingBatches=%d, maxInflightBatches=%s",
			this.streamName,
			bytes,
			numBatches,
			this.queuedBytes,
			this.pendingBytes,
			this.maxQueuedBytes,
			this.inflight.length,
			this.pendingBatches,
			this.maxInflightBatches ?? "unlimited",
		);

		// Check if we have capacity
		while (true) {
			// Check for fatal error before adding to pendingBytes
			if (this.fatalError) {
				debugSession(
					"[%s] [CAPACITY] fatal error detected, rejecting: %s",
					this.streamName,
					this.fatalError.message,
				);
				throw this.fatalError;
			}

			// Byte-based gating
			if (this.queuedBytes + this.pendingBytes + bytes <= this.maxQueuedBytes) {
				// Batch-based gating (if configured)
				if (
					this.maxInflightBatches === undefined ||
					this.inflight.length + this.pendingBatches + numBatches <=
						this.maxInflightBatches
				) {
					debugSession(
						"[%s] [CAPACITY] capacity available, adding %d to pendingBytes and %d to pendingBatches",
						this.streamName,
						bytes,
						numBatches,
					);
					this.pendingBytes += bytes;
					this.pendingBatches += numBatches;
					return;
				}
			}

			// No capacity - wait in queue
			debugSession(
				"[%s] [CAPACITY] no capacity, waiting for release",
				this.streamName,
			);
			await new Promise<void>((resolve) => {
				this.capacityWaiters.push({
					resolve,
					bytes,
					batches: numBatches,
				});
			});
			debugSession("[%s] [CAPACITY] woke up, rechecking", this.streamName);
		}
	}

	/**
	 * Submit an append request.
	 * Returns a promise that resolves to a submit ticket once the batch is enqueued (has capacity).
	 * The ticket's ack() can be awaited to get the AppendAck once the batch is durable.
	 * This method applies backpressure and will block if capacity limits are reached.
	 */
	async submit(input: Types.AppendInput): Promise<BatchSubmitTicket> {
		if (this.closed || this.closing) {
			return Promise.reject(
				new S2Error({ message: "AppendSession is closed" }),
			);
		}

		// Use cached metered size from AppendInput
		const batchMeteredSize = input.meteredBytes;

		// This needs to happen in the sync path.
		this.ensurePump();

		// Wait for capacity (this is where backpressure is applied - outer promise resolves when enqueued)
		await this.waitForCapacity(batchMeteredSize, 1);

		// Move reserved bytes and batches to queued accounting before submission
		this.pendingBytes = Math.max(0, this.pendingBytes - batchMeteredSize);
		this.pendingBatches = Math.max(0, this.pendingBatches - 1);

		// Create the inner promise that resolves when durable
		const innerPromise = this.submitInternal(input, batchMeteredSize).then(
			(result) => {
				if (result.ok) {
					return result.value;
				} else {
					throw result.error;
				}
			},
		);

		// Prevent early rejections from surfacing as unhandled when callers delay ack()
		innerPromise.catch(() => {});

		// Return ticket immediately (outer promise has resolved via waitForCapacity)
		return new BatchSubmitTicket(
			innerPromise,
			batchMeteredSize,
			input.records.length,
		);
	}

	/**
	 * Internal submit that returns discriminated union.
	 * Creates inflight entry and starts pump if needed.
	 */
	private submitInternal(
		input: Types.AppendInput,
		batchMeteredSize: number,
	): Promise<AppendResult> {
		// Check for fatal error (e.g., from abort())
		if (this.fatalError) {
			debugSession(
				"[%s] [SUBMIT] rejecting due to fatal error: %s",
				this.streamName,
				this.fatalError.message,
			);
			return Promise.resolve(err(this.fatalError));
		}

		// Create promise for submit() callers
		return new Promise<AppendResult>((resolve) => {
			// Create inflight entry (innerPromise will be set when pump processes it)
			const entry: InflightEntry = {
				input,
				expectedCount: input.records.length,
				innerPromise: new Promise(() => {}), // Never-resolving placeholder
				maybeResolve: resolve,
				needsSubmit: true, // Mark for pump to submit
			};

			debugSession(
				"[%s] [SUBMIT] enqueueing %d records (%d bytes), match_seq_num=%s: inflight=%d->%d, queuedBytes=%d->%d",
				this.streamName,
				input.records.length,
				batchMeteredSize,
				input.matchSeqNum ?? "none",
				this.inflight.length,
				this.inflight.length + 1,
				this.queuedBytes,
				this.queuedBytes + batchMeteredSize,
			);

			this.inflight.push(entry);
			this.queuedBytes += batchMeteredSize;

			// Wake pump if it's sleeping
			if (this.pumpWakeup) {
				this.pumpWakeup();
			}

			// Start pump if not already running
			this.ensurePump();
		});
	}

	/**
	 * Release capacity and wake waiter if present.
	 */
	private releaseCapacity(bytes: number): void {
		debugSession(
			"[%s] [CAPACITY] releasing %d bytes: queuedBytes=%d->%d, pendingBytes=%d->%d, pendingBatches=%d, numWaiters=%d",
			this.streamName,
			bytes,
			this.queuedBytes,
			this.queuedBytes - bytes,
			this.pendingBytes,
			Math.max(0, this.pendingBytes - bytes),
			this.pendingBatches,
			this.capacityWaiters.length,
		);
		this.queuedBytes -= bytes;
		this.pendingBytes = Math.max(0, this.pendingBytes - bytes);

		this.wakeCapacityWaiters();
	}

	private wakeCapacityWaiters(): void {
		if (this.capacityWaiters.length === 0) {
			return;
		}

		let availableBytes = Math.max(
			0,
			this.maxQueuedBytes - (this.queuedBytes + this.pendingBytes),
		);
		let availableBatches =
			this.maxInflightBatches === undefined
				? Number.POSITIVE_INFINITY
				: Math.max(
						0,
						this.maxInflightBatches -
							(this.inflight.length + this.pendingBatches),
					);

		while (this.capacityWaiters.length > 0) {
			const next = this.capacityWaiters[0]!;
			const needsBytes = next.bytes;
			const needsBatches = next.batches;
			const hasBatchCapacity =
				this.maxInflightBatches === undefined ||
				needsBatches <= availableBatches;

			if (needsBytes <= availableBytes && hasBatchCapacity) {
				this.capacityWaiters.shift();
				availableBytes -= needsBytes;
				if (this.maxInflightBatches !== undefined) {
					availableBatches -= needsBatches;
				}
				debugSession(
					"[%s] [CAPACITY] waking waiter (bytes=%d, batches=%d)",
					this.streamName,
					needsBytes,
					needsBatches,
				);
				next.resolve();
				continue;
			}

			// Not enough capacity for the next waiter yet - keep them queued.
			break;
		}
	}

	/**
	 * Ensure pump loop is running.
	 */
	private ensurePump(): void {
		if (this.pumpPromise || this.pumpStopped) {
			return;
		}

		this.pumpPromise = this.runPump().catch((e) => {
			debugSession("[%s] pump crashed unexpectedly: %s", this.streamName, e);
			// This should never happen - pump handles all errors internally
		});
	}

	/**
	 * Main pump loop: processes inflight queue, handles acks, retries, and recovery.
	 */
	private async runPump(): Promise<void> {
		debugSession("[%s] pump started", this.streamName);

		while (true) {
			debugSession(
				"[%s] [PUMP] loop: inflight=%d, queuedBytes=%d, pendingBytes=%d, pendingBatches=%d, closing=%s, pumpStopped=%s",
				this.streamName,
				this.inflight.length,
				this.queuedBytes,
				this.pendingBytes,
				this.pendingBatches,
				this.closing,
				this.pumpStopped,
			);

			// Check if we should stop
			if (this.pumpStopped) {
				debugSession("[%s] [PUMP] stopped by flag", this.streamName);
				return;
			}

			// If closing and queue is empty, stop
			// BUT: if there are capacity waiters, they might add to inflight, so keep running
			if (
				this.closing &&
				this.inflight.length === 0 &&
				this.capacityWaiters.length === 0
			) {
				debugSession(
					"[%s] [PUMP] closing and queue empty, stopping",
					this.streamName,
				);
				this.pumpStopped = true;
				return;
			}

			// If no entries, sleep and continue
			if (this.inflight.length === 0) {
				debugSession(
					"[%s] [PUMP] no entries, parking until wakeup",
					this.streamName,
				);
				await new Promise<void>((resolve) => {
					this.pumpWakeup = resolve;
				});
				this.pumpWakeup = undefined;
				continue;
			}

			// Get head entry (we know it exists because we checked length above)
			const head = this.inflight[0]!;
			debugSession(
				"[%s] [PUMP] processing head: expectedCount=%d, meteredBytes=%d, match_seq_num=%s",
				this.streamName,
				head.expectedCount,
				head.input.meteredBytes,
				head.input.matchSeqNum ?? "none",
			);

			// Ensure session exists
			debugSession("[%s] [PUMP] ensuring session exists", this.streamName);
			await this.ensureSession();
			if (!this.session) {
				// Session creation failed - will retry
				this.consecutiveFailures++;
				const delay = calculateDelay(
					this.consecutiveFailures - 1,
					this.retryConfig.minDelayMillis,
					this.retryConfig.maxDelayMillis,
				);
				debugSession(
					"[%s] [PUMP] session creation failed, backing off for %dms",
					this.streamName,
					delay,
				);
				await sleep(delay);
				continue;
			}

			// Submit ALL entries that need submitting (enables HTTP/2 pipelining for S2S)
			for (const entry of this.inflight) {
				if (!entry.innerPromise || entry.needsSubmit) {
					debugSession(
						"[%s] [PUMP] submitting entry to inner session (%d records, %d bytes, match_seq_num=%s)",
						this.streamName,
						entry.expectedCount,
						entry.input.meteredBytes,
						entry.input.matchSeqNum ?? "none",
					);
					const attemptStarted = performance.now();
					entry.attemptStartedMonotonicMs = attemptStarted;
					entry.innerPromise = this.session.submit(entry.input);
					delete entry.needsSubmit;
				}
			}

			// Wait for head with timeout
			debugSession("[%s] [PUMP] waiting for head result", this.streamName);
			const result = await this.waitForHead(head);
			debugSession(
				"[%s] [PUMP] got result: kind=%s",
				this.streamName,
				result.kind,
			);

			// Convert result to AppendResult (timeout becomes retryable error)
			let appendResult: AppendResult;
			if (result.kind === "timeout") {
				// Ack timeout - convert to retryable error that flows through retry logic
				const attemptElapsed =
					head.attemptStartedMonotonicMs != null
						? Math.round(performance.now() - head.attemptStartedMonotonicMs)
						: undefined;
				const error = new S2Error({
					message: `Request timeout after ${attemptElapsed ?? "unknown"}ms (${
						head.expectedCount
					} records, ${head.input.meteredBytes} bytes)`,
					status: 408,
					code: "REQUEST_TIMEOUT",
					origin: "sdk",
				});
				debugSession(
					"[%s] ack timeout for head entry: %s",
					this.streamName,
					error.message,
				);
				appendResult = err(error);
			} else {
				// Promise settled
				appendResult = result.value;
			}

			if (appendResult.ok) {
				// Success!
				const ack = appendResult.value;
				debugSession(
					"[%s] [PUMP] success, got ack: seq_num=%d-%d",
					this.streamName,
					ack.start.seqNum,
					ack.end.seqNum,
				);

				// Invariant check: ack count matches batch count
				const ackCount = ack.end.seqNum - ack.start.seqNum;
				if (ackCount !== head.expectedCount) {
					const error = invariantViolation(
						`Ack count mismatch: expected ${head.expectedCount}, got ${ackCount}`,
					);
					debugSession(
						"[%s] invariant violation: %s",
						this.streamName,
						error.message,
					);
					await this.abort(error);
					return;
				}

				// Invariant check: sequence numbers must be strictly increasing
				if (this._lastAckedPosition) {
					const prevEnd = this._lastAckedPosition.end.seqNum;
					const currentEnd = ack.end.seqNum;
					if (currentEnd <= prevEnd) {
						const error = invariantViolation(
							`Sequence number not strictly increasing: previous=${prevEnd}, current=${currentEnd}`,
						);
						debugSession(
							"[%s] invariant violation: %s",
							this.streamName,
							error.message,
						);
						await this.abort(error);
						return;
					}
				}

				// Update last acked position
				this._lastAckedPosition = ack;

				// Resolve submit() caller if present
				if (head.maybeResolve) {
					head.maybeResolve(ok(ack));
				}

				// Emit to readable stream
				try {
					this.acksController?.enqueue(ack);
				} catch (e) {
					debugSession("[%s] failed to enqueue ack: %s", this.streamName, e);
				}

				// Remove from inflight and release capacity
				debugSession(
					"[%s] [PUMP] removing head from inflight, releasing %d bytes",
					this.streamName,
					head.input.meteredBytes,
				);
				this.inflight.shift();
				this.releaseCapacity(head.input.meteredBytes);

				// Reset consecutive failures on success
				this.consecutiveFailures = 0;
				this.currentAttempt = 0;
			} else {
				// Error result
				const error = appendResult.error;
				debugSession(
					"[%s] [PUMP] error: status=%s, message=%s",
					this.streamName,
					error.status,
					error.message,
				);

				// Check if retryable
				if (!isRetryable(error)) {
					debugSession("[%s] error not retryable, aborting", this.streamName);
					await this.abort(error);
					return;
				}

				// Check policy compliance
				if (
					this.retryConfig.appendRetryPolicy === "noSideEffects" &&
					!this.isIdempotent(head)
				) {
					debugSession(
						"[%s] error not policy-compliant (noSideEffects), aborting",
						this.streamName,
					);
					await this.abort(error);
					return;
				}

				// Check max attempts (total attempts include initial; retries = max - 1)
				const effectiveMax = Math.max(1, this.retryConfig.maxAttempts);
				const allowedRetries = effectiveMax - 1;
				if (this.currentAttempt >= allowedRetries) {
					debugSession(
						"[%s] max attempts reached (%d), aborting",
						this.streamName,
						effectiveMax,
					);
					const wrappedError = new S2Error({
						message: `Max attempts (${effectiveMax}) exhausted: ${error.message}`,
						status: error.status,
						code: error.code,
					});
					await this.abort(wrappedError);
					return;
				}

				// Perform recovery
				this.consecutiveFailures++;
				this.currentAttempt++;

				debugSession(
					"[%s] performing recovery (retry %d/%d)",
					this.streamName,
					this.currentAttempt,
					allowedRetries,
				);

				await this.recover();
			}
		}
	}

	/**
	 * Wait for head entry's innerPromise with timeout.
	 * Returns either the settled result or a timeout indicator.
	 *
	 * Per-attempt ack timeout semantics:
	 * - The deadline is computed from the current attempt's start time using a
	 *   monotonic clock (performance.now) to avoid issues with wall clock adjustments.
	 * - Each retry gets a fresh timeout window (attemptStartedMonotonicMs is reset
	 *   during recovery).
	 * - If attempt start is missing (for backward compatibility), we measure
	 *   from "now" with the full timeout window.
	 */
	private async waitForHead(
		head: InflightEntry,
	): Promise<{ kind: "settled"; value: AppendResult } | { kind: "timeout" }> {
		const attemptStart = head.attemptStartedMonotonicMs ?? performance.now();
		const deadline = attemptStart + this.requestTimeoutMillis;
		const remaining = Math.max(0, deadline - performance.now());

		let timer: any;
		const timeoutP = new Promise<{ kind: "timeout" }>((resolve) => {
			timer = setTimeout(() => resolve({ kind: "timeout" }), remaining);
		});

		const settledP = head.innerPromise.then((result) => ({
			kind: "settled" as const,
			value: result,
		}));

		try {
			return await Promise.race([settledP, timeoutP]);
		} finally {
			if (timer) clearTimeout(timer);
		}
	}

	/**
	 * Recover from transient error: recreate session and resubmit all inflight entries.
	 */
	private async recover(): Promise<void> {
		debugSession("[%s] starting recovery", this.streamName);

		// Calculate backoff delay
		const delay = calculateDelay(
			this.consecutiveFailures - 1,
			this.retryConfig.minDelayMillis,
			this.retryConfig.maxDelayMillis,
		);
		debugSession("[%s] backing off for %dms", this.streamName, delay);
		await sleep(delay);

		// Teardown old session
		if (this.session) {
			try {
				const closeResult = await this.session.close();
				if (!closeResult.ok) {
					debugSession(
						"[%s] error closing old session during recovery: %s",
						this.streamName,
						closeResult.error.message,
					);
				}
			} catch (e) {
				debugSession(
					"[%s] exception closing old session: %s",
					this.streamName,
					e,
				);
			}
			this.session = undefined;
		}

		// Create new session
		await this.ensureSession();
		if (!this.session) {
			debugSession(
				"[%s] failed to create new session during recovery",
				this.streamName,
			);
			// Will retry on next pump iteration
			return;
		}

		// Store session in local variable to help TypeScript type narrowing
		const session: TransportAppendSession = this.session;

		// Resubmit all inflight entries (replace their innerPromise and reset attempt start)
		debugSession(
			"[%s] resubmitting %d inflight entries",
			this.streamName,
			this.inflight.length,
		);
		for (const entry of this.inflight) {
			// Attach .catch to superseded promise to avoid unhandled rejection
			entry.innerPromise.catch(() => {});

			// Create new promise from new session
			const attemptStarted = performance.now();
			entry.attemptStartedMonotonicMs = attemptStarted;
			entry.innerPromise = session.submit(entry.input);
			debugSession(
				"[%s] resubmitted entry (%d records, %d bytes, match_seq_num=%s)",
				this.streamName,
				entry.expectedCount,
				entry.input.meteredBytes,
				entry.input.matchSeqNum ?? "none",
			);
		}

		debugSession("[%s] recovery complete", this.streamName);
	}

	/**
	 * Check if append can be retried under noSideEffects policy.
	 * For appends, idempotency requires match_seq_num.
	 */
	private isIdempotent(entry: InflightEntry): boolean {
		return entry.input.matchSeqNum !== undefined;
	}

	/**
	 * Ensure session exists, creating it if necessary.
	 */
	private async ensureSession(): Promise<void> {
		if (this.session) {
			return;
		}

		try {
			debugSession("[%s] creating new transport session", this.streamName);
			this.session = await this.generator(this.sessionOptions);
			debugSession("[%s] transport session created", this.streamName);
		} catch (e) {
			const error = s2Error(e);
			debugSession(
				"[%s] failed to create session: %s",
				this.streamName,
				error.message,
			);
			// Don't set this.session - will retry later
		}
	}

	/**
	 * Abort the session with a fatal error.
	 */
	private async abort(error: S2Error): Promise<void> {
		if (this.pumpStopped) {
			return; // Already aborted
		}

		debugSession("[%s] aborting session: %s", this.streamName, error.message);

		this.fatalError = error;
		this.pumpStopped = true;

		// Resolve all inflight entries with error
		debugSession(
			"[%s] rejecting %d inflight entries",
			this.streamName,
			this.inflight.length,
		);
		for (const entry of this.inflight) {
			if (entry.maybeResolve) {
				entry.maybeResolve(err(error));
			}
		}
		this.inflight.length = 0;
		this.queuedBytes = 0;
		this.pendingBytes = 0;
		this.pendingBatches = 0;

		// Error the readable stream
		try {
			this.acksController?.error(error);
		} catch (e) {
			debugSession(
				"[%s] failed to error acks controller: %s",
				this.streamName,
				e,
			);
		}

		// Wake all capacity waiters to unblock any pending writers
		for (const waiter of this.capacityWaiters) {
			waiter.resolve();
		}
		this.capacityWaiters = [];

		// Close inner session
		if (this.session) {
			debugSession("[%s] closing inner session", this.streamName);
			try {
				await this.session.close();
			} catch (e) {
				debugSession(
					"[%s] error closing session during abort: %s",
					this.streamName,
					e,
				);
			}
			this.session = undefined;
		}
	}

	/**
	 * Close the append session.
	 * Waits for all pending appends to complete before resolving.
	 * Does not interrupt recovery - allows it to complete.
	 */
	async close(): Promise<void> {
		if (this.closed) {
			if (this.fatalError) {
				throw this.fatalError;
			}
			return;
		}

		debugSession("[%s] close requested", this.streamName);
		this.closing = true;

		// Wake pump if it's sleeping so it can check closing flag
		if (this.pumpWakeup) {
			this.pumpWakeup();
		}

		// Wait for pump to stop (drains inflight queue, including through recovery)
		if (this.pumpPromise) {
			debugSession(
				"[%s] [CLOSE] awaiting pump to drain inflight queue",
				this.streamName,
			);
			await this.pumpPromise;
		}

		// Close inner session
		if (this.session) {
			try {
				const result = await this.session.close();
				if (!result.ok) {
					debugSession(
						"[%s] error closing inner session: %s",
						this.streamName,
						result.error.message,
					);
				}
			} catch (e) {
				debugSession(
					"[%s] exception closing inner session: %s",
					this.streamName,
					e,
				);
			}
			this.session = undefined;
		}

		// Close readable stream
		try {
			this.acksController?.close();
		} catch (e) {
			debugSession(
				"[%s] error closing acks controller: %s",
				this.streamName,
				e,
			);
		}

		this.closed = true;

		// If fatal error occurred, throw it
		if (this.fatalError) {
			throw this.fatalError;
		}

		debugSession("[%s] close complete", this.streamName);
	}

	async [Symbol.asyncDispose](): Promise<void> {
		await this.close();
	}

	/**
	 * Get a stream of acknowledgements for appends.
	 */
	acks(): AcksStream {
		return this.readable as AcksStream;
	}

	/**
	 * Get the last acknowledged position.
	 */
	lastAckedPosition(): Types.AppendAck | undefined {
		return this._lastAckedPosition;
	}
}
