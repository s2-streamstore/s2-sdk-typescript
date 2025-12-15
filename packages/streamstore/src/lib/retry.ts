import createDebug from "debug";
import type { RetryConfig } from "../common.js";
import {
	abortedError,
	invariantViolation,
	S2Error,
	s2Error,
	withS2Error,
} from "../error.js";
import type { AppendAck, StreamPosition } from "../generated/index.js";
import { meteredBytes } from "../utils.js";
import type { AppendResult, CloseResult } from "./result.js";
import { err, errClose, ok, okClose } from "./result.js";
import type {
	AcksStream,
	AppendArgs,
	AppendRecord,
	AppendSessionOptions,
	AppendSession as AppendSessionType,
	ReadArgs,
	ReadRecord,
	ReadSession as ReadSessionType,
	TransportAppendSession,
	TransportReadSession,
} from "./stream/types.js";

const debugWith = createDebug("s2:retry:with");
const debugRead = createDebug("s2:retry:read");
const debugSession = createDebug("s2:retry:session");

/**
 * Default retry configuration.
 */
export const DEFAULT_RETRY_CONFIG: Required<RetryConfig> & {
	requestTimeoutMillis: number;
} = {
	maxAttempts: 3,
	retryBackoffDurationMillis: 100,
	appendRetryPolicy: "all",
	requestTimeoutMillis: 5000, // 5 seconds
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
 * Calculates the delay before the next retry attempt using fixed backoff
 * with jitter. The `attempt` parameter is currently ignored to keep a
 * constant base delay per attempt.
 */
export function calculateDelay(
	attempt: number,
	baseDelayMillis: number,
): number {
	// Apply ±50% jitter around the base delay
	const jitterRange = 0.5; // 50% up or down
	const factor = 1 + (Math.random() * 2 - 1) * jitterRange; // [0.5, 1.5]
	const delay = Math.max(0, baseDelayMillis * factor);
	return Math.floor(delay);
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
				config.retryBackoffDurationMillis,
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
	extends ReadableStream<ReadRecord<Format>>
	implements ReadSessionType<Format>
{
	private _nextReadPosition: StreamPosition | undefined = undefined;
	private _lastObservedTail: StreamPosition | undefined = undefined;

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
				const error =
					err instanceof S2Error
						? err
						: new S2Error({
								message: String(err),
								status: 502,
							});
				lastError = error;

				const effectiveMax = Math.max(1, retryConfig.maxAttempts);
				if (isRetryable(error) && attempt < effectiveMax - 1) {
					const delay = calculateDelay(
						attempt,
						retryConfig.retryBackoffDurationMillis,
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
							const error =
								err instanceof S2Error
									? err
									: new S2Error({
											message: String(err),
											status: 502, // Bad Gateway - connection failure
										});

							// Check if we can retry connection errors
							const effectiveMax = Math.max(1, retryConfig.maxAttempts);
							if (isRetryable(error) && attempt < effectiveMax - 1) {
								const delay = calculateDelay(
									attempt,
									retryConfig.retryBackoffDurationMillis,
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
									retryConfig.retryBackoffDurationMillis,
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

						controller.enqueue(record);
					}
				}
			},
			cancel: async (reason) => {
				try {
					await session?.cancel(reason);
				} catch (err) {
					// Ignore ERR_INVALID_STATE - stream may already be closed/cancelled
					if ((err as any)?.code !== "ERR_INVALID_STATE") {
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
	[Symbol.asyncIterator](): AsyncIterableIterator<ReadRecord<Format>> {
		const fn = (ReadableStream.prototype as any)[Symbol.asyncIterator];
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
					if ((err as any)?.code !== "ERR_INVALID_STATE") throw err;
				}
				reader.releaseLock();
				return { done: true, value: undefined };
			},
			return: async () => {
				try {
					await reader.cancel("done");
				} catch (err) {
					if ((err as any)?.code !== "ERR_INVALID_STATE") throw err;
				}
				reader.releaseLock();
				return { done: true, value: undefined };
			},
			[Symbol.asyncIterator]() {
				return this;
			},
		};
	}

	lastObservedTail(): StreamPosition | undefined {
		return this._lastObservedTail;
	}

	nextReadPosition(): StreamPosition | undefined {
		return this._nextReadPosition;
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
	records: AppendRecord[];
	args?: Omit<AppendArgs, "records"> & { precalculatedSize?: number };
	expectedCount: number;
	meteredBytes: number;
	attemptStartedMonotonicMs?: number; // Monotonic timestamp (performance.now) for per-attempt ack timeout anchoring
	innerPromise: Promise<AppendResult>; // Promise from transport session
	maybeResolve?: (result: AppendResult) => void; // Resolver for submit() callers
	needsSubmit?: boolean;
};

const DEFAULT_MAX_INFLIGHT_BYTES = 10 * 1024 * 1024; // 10 MiB default

export class RetryAppendSession implements AsyncDisposable, AppendSessionType {
	private readonly requestTimeoutMillis: number;
	private readonly maxQueuedBytes: number;
	private readonly maxInflightBatches?: number;
	private readonly retryConfig: Required<RetryConfig> & {
		requestTimeoutMillis: number;
	};

	private readonly inflight: InflightEntry[] = [];
	private capacityWaiter?: () => void; // Single waiter (WritableStream writer lock)

	private session?: TransportAppendSession;
	private queuedBytes = 0;
	private pendingBytes = 0;
	private consecutiveFailures = 0;
	private currentAttempt = 0;

	private pumpPromise?: Promise<void>;
	private pumpStopped = false;
	private closing = false;
	private pumpWakeup?: () => void;
	private closed = false;
	private fatalError?: S2Error;

	private _lastAckedPosition?: AppendAck;
	private acksController?: ReadableStreamDefaultController<AppendAck>;

	public readonly readable: ReadableStream<AppendAck>;
	public readonly writable: WritableStream<AppendArgs>;

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
	) {
		this.retryConfig = {
			...DEFAULT_RETRY_CONFIG,
			...config,
		};
		this.requestTimeoutMillis = this.retryConfig.requestTimeoutMillis;
		this.maxQueuedBytes =
			this.sessionOptions?.maxInflightBytes ?? DEFAULT_MAX_INFLIGHT_BYTES;
		this.maxInflightBatches = this.sessionOptions?.maxInflightBatches;

		this.readable = new ReadableStream<AppendAck>({
			start: (controller) => {
				this.acksController = controller;
			},
		});

		this.writable = new WritableStream<AppendArgs>({
			write: async (chunk) => {
				const recordsArray = Array.isArray(chunk.records)
					? chunk.records
					: [chunk.records];

				// Calculate metered size
				let batchMeteredSize = 0;
				for (const record of recordsArray) {
					batchMeteredSize += meteredBytes(record);
				}

				// Wait for capacity (backpressure for writable only)
				await this.waitForCapacity(batchMeteredSize);

				const { records: _records, ...rest } = chunk;
				const args: Omit<AppendArgs, "records"> & {
					precalculatedSize?: number;
				} = rest;
				args.precalculatedSize = batchMeteredSize;

				// Move reserved bytes to queued bytes accounting before submission
				this.pendingBytes = Math.max(0, this.pendingBytes - batchMeteredSize);

				// Submit without waiting for ack (writable doesn't need per-batch resolution)
				const promise = this.submitInternal(
					recordsArray,
					args,
					batchMeteredSize,
				);
				promise.catch(() => {
					// Swallow to avoid unhandled rejection; pump surfaces errors via readable stream
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
	): Promise<RetryAppendSession> {
		return new RetryAppendSession(generator, sessionOptions, config);
	}

	/**
	 * Submit an append request. Returns a promise that resolves with the ack.
	 * This method does not block on capacity (only writable.write() does).
	 */
	async submit(
		records: AppendRecord | AppendRecord[],
		args?: Omit<AppendArgs, "records"> & { precalculatedSize?: number },
	): Promise<AppendAck> {
		const recordsArray = Array.isArray(records) ? records : [records];

		// Calculate metered size if not provided
		let batchMeteredSize = args?.precalculatedSize ?? 0;
		if (batchMeteredSize === 0) {
			for (const record of recordsArray) {
				batchMeteredSize += meteredBytes(record);
			}
		}

		const result = await this.submitInternal(
			recordsArray,
			args,
			batchMeteredSize,
		);

		// Convert discriminated union back to throw pattern for public API
		if (result.ok) {
			return result.value;
		} else {
			throw result.error;
		}
	}

	/**
	 * Internal submit that returns discriminated union.
	 * Creates inflight entry and starts pump if needed.
	 */
	private submitInternal(
		records: AppendRecord[],
		args:
			| (Omit<AppendArgs, "records"> & { precalculatedSize?: number })
			| undefined,
		batchMeteredSize: number,
	): Promise<AppendResult> {
		if (this.closed || this.closing) {
			return Promise.resolve(
				err(new S2Error({ message: "AppendSession is closed", status: 400 })),
			);
		}

		// Check for fatal error (e.g., from abort())
		if (this.fatalError) {
			debugSession(
				"[SUBMIT] rejecting due to fatal error: %s",
				this.fatalError.message,
			);
			return Promise.resolve(err(this.fatalError));
		}

		// Create promise for submit() callers
		return new Promise<AppendResult>((resolve) => {
			// Create inflight entry (innerPromise will be set when pump processes it)
			const entry: InflightEntry = {
				records,
				args,
				expectedCount: records.length,
				meteredBytes: batchMeteredSize,
				innerPromise: new Promise(() => {}), // Never-resolving placeholder
				maybeResolve: resolve,
				needsSubmit: true, // Mark for pump to submit
			};

			debugSession(
				"[SUBMIT] enqueueing %d records (%d bytes): inflight=%d->%d, queuedBytes=%d->%d",
				records.length,
				batchMeteredSize,
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
	 * Wait for capacity before allowing write to proceed (writable only).
	 */
	private async waitForCapacity(bytes: number): Promise<void> {
		debugSession(
			"[CAPACITY] checking for %d bytes: queuedBytes=%d, pendingBytes=%d, maxQueuedBytes=%d, inflight=%d",
			bytes,
			this.queuedBytes,
			this.pendingBytes,
			this.maxQueuedBytes,
			this.inflight.length,
		);

		// Check if we have capacity
		while (true) {
			// Check for fatal error before adding to pendingBytes
			if (this.fatalError) {
				debugSession(
					"[CAPACITY] fatal error detected, rejecting: %s",
					this.fatalError.message,
				);
				throw this.fatalError;
			}

			// Byte-based gating
			if (this.queuedBytes + this.pendingBytes + bytes <= this.maxQueuedBytes) {
				// Batch-based gating (if configured)
				if (
					this.maxInflightBatches === undefined ||
					this.inflight.length < this.maxInflightBatches
				) {
					debugSession(
						"[CAPACITY] capacity available, adding %d to pendingBytes",
						bytes,
					);
					this.pendingBytes += bytes;
					return;
				}
			}

			// No capacity - wait
			// WritableStream enforces writer lock, so only one write can be blocked at a time
			debugSession("[CAPACITY] no capacity, waiting for release");
			await new Promise<void>((resolve) => {
				this.capacityWaiter = resolve;
			});
			debugSession("[CAPACITY] woke up, rechecking");
		}
	}

	/**
	 * Release capacity and wake waiter if present.
	 */
	private releaseCapacity(bytes: number): void {
		debugSession(
			"[CAPACITY] releasing %d bytes: queuedBytes=%d->%d, pendingBytes=%d->%d, hasWaiter=%s",
			bytes,
			this.queuedBytes,
			this.queuedBytes - bytes,
			this.pendingBytes,
			Math.max(0, this.pendingBytes - bytes),
			!!this.capacityWaiter,
		);
		this.queuedBytes -= bytes;
		this.pendingBytes = Math.max(0, this.pendingBytes - bytes);

		// Wake single waiter
		const waiter = this.capacityWaiter;
		if (waiter) {
			debugSession("[CAPACITY] waking waiter");
			this.capacityWaiter = undefined;
			waiter();
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
			debugSession("pump crashed unexpectedly: %s", e);
			// This should never happen - pump handles all errors internally
		});
	}

	/**
	 * Main pump loop: processes inflight queue, handles acks, retries, and recovery.
	 */
	private async runPump(): Promise<void> {
		debugSession("pump started");

		while (true) {
			debugSession(
				"[PUMP] loop: inflight=%d, queuedBytes=%d, pendingBytes=%d, closing=%s, pumpStopped=%s",
				this.inflight.length,
				this.queuedBytes,
				this.pendingBytes,
				this.closing,
				this.pumpStopped,
			);

			// Check if we should stop
			if (this.pumpStopped) {
				debugSession("[PUMP] stopped by flag");
				return;
			}

			// If closing and queue is empty, stop
			if (this.closing && this.inflight.length === 0) {
				debugSession("[PUMP] closing and queue empty, stopping");
				this.pumpStopped = true;
				return;
			}

			// If no entries, sleep and continue
			if (this.inflight.length === 0) {
				debugSession("[PUMP] no entries, sleeping 10ms");
				// Use interruptible sleep - can be woken by new submissions
				await Promise.race([
					sleep(10),
					new Promise<void>((resolve) => {
						this.pumpWakeup = resolve;
					}),
				]);
				this.pumpWakeup = undefined;
				continue;
			}

			// Get head entry (we know it exists because we checked length above)
			const head = this.inflight[0]!;
			debugSession(
				"[PUMP] processing head: expectedCount=%d, meteredBytes=%d",
				head.expectedCount,
				head.meteredBytes,
			);

			// Ensure session exists
			debugSession("[PUMP] ensuring session exists");
			await this.ensureSession();
			if (!this.session) {
				// Session creation failed - will retry
				debugSession("[PUMP] session creation failed, sleeping 100ms");
				await sleep(100);
				continue;
			}

			// Submit ALL entries that need submitting (enables HTTP/2 pipelining for S2S)
			for (const entry of this.inflight) {
				if (!entry.innerPromise || entry.needsSubmit) {
					debugSession(
						"[PUMP] submitting entry to inner session (%d records, %d bytes)",
						entry.expectedCount,
						entry.meteredBytes,
					);
					entry.attemptStartedMonotonicMs = performance.now();
					entry.innerPromise = this.session.submit(entry.records, entry.args);
					delete entry.needsSubmit;
				}
			}

			// Wait for head with timeout
			debugSession("[PUMP] waiting for head result");
			const result = await this.waitForHead(head);
			debugSession("[PUMP] got result: kind=%s", result.kind);

			if (result.kind === "timeout") {
				// Ack timeout - fatal (per-attempt)
				const attemptElapsed =
					head.attemptStartedMonotonicMs != null
						? Math.round(performance.now() - head.attemptStartedMonotonicMs)
						: undefined;
				const error = new S2Error({
					message: `Request timeout after ${attemptElapsed ?? "unknown"}ms (${head.expectedCount} records, ${head.meteredBytes} bytes)`,
					status: 408,
					code: "REQUEST_TIMEOUT",
				});
				debugSession("ack timeout for head entry: %s", error.message);
				await this.abort(error);
				return;
			}

			// Promise settled
			const appendResult = result.value;

			if (appendResult.ok) {
				// Success!
				const ack = appendResult.value;
				debugSession("[PUMP] success, got ack", { ack });

				// Invariant check: ack count matches batch count
				const ackCount = Number(ack.end.seq_num) - Number(ack.start.seq_num);
				if (ackCount !== head.expectedCount) {
					const error = invariantViolation(
						`Ack count mismatch: expected ${head.expectedCount}, got ${ackCount}`,
					);
					debugSession("invariant violation: %s", error.message);
					await this.abort(error);
					return;
				}

				// Invariant check: sequence numbers must be strictly increasing
				if (this._lastAckedPosition) {
					const prevEnd = BigInt(this._lastAckedPosition.end.seq_num);
					const currentEnd = BigInt(ack.end.seq_num);
					if (currentEnd <= prevEnd) {
						const error = invariantViolation(
							`Sequence number not strictly increasing: previous=${prevEnd}, current=${currentEnd}`,
						);
						debugSession("invariant violation: %s", error.message);
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
					debugSession("failed to enqueue ack: %s", e);
				}

				// Remove from inflight and release capacity
				debugSession(
					"[PUMP] removing head from inflight, releasing %d bytes",
					head.meteredBytes,
				);
				this.inflight.shift();
				this.releaseCapacity(head.meteredBytes);

				// Reset consecutive failures on success
				this.consecutiveFailures = 0;
				this.currentAttempt = 0;
			} else {
				// Error result
				const error = appendResult.error;
				debugSession(
					"[PUMP] error: status=%s, message=%s",
					error.status,
					error.message,
				);

				// Check if retryable
				if (!isRetryable(error)) {
					debugSession("error not retryable, aborting");
					await this.abort(error);
					return;
				}

				// Check policy compliance
				if (
					this.retryConfig.appendRetryPolicy === "noSideEffects" &&
					!this.isIdempotent(head)
				) {
					debugSession("error not policy-compliant (noSideEffects), aborting");
					await this.abort(error);
					return;
				}

				// Check max attempts (total attempts include initial; retries = max - 1)
				const effectiveMax = Math.max(1, this.retryConfig.maxAttempts);
				const allowedRetries = effectiveMax - 1;
				if (this.currentAttempt >= allowedRetries) {
					debugSession("max attempts reached (%d), aborting", effectiveMax);
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
					"performing recovery (retry %d/%d)",
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
	 * - The deadline is computed from the most recent (re)submit attempt using
	 *   a monotonic clock (performance.now) to avoid issues with wall clock
	 *   adjustments.
	 * - If attempt start is missing (for backward compatibility), we measure
	 *   from "now" with the full timeout window.
	 */
	private async waitForHead(
		head: InflightEntry,
	): Promise<{ kind: "settled"; value: AppendResult } | { kind: "timeout" }> {
		const startMono = head.attemptStartedMonotonicMs ?? performance.now();
		const deadline = startMono + this.requestTimeoutMillis;
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
		debugSession("starting recovery");

		// Calculate backoff delay
		const delay = calculateDelay(
			this.consecutiveFailures - 1,
			this.retryConfig.retryBackoffDurationMillis,
		);
		debugSession("backing off for %dms", delay);
		await sleep(delay);

		// Teardown old session
		if (this.session) {
			try {
				const closeResult = await this.session.close();
				if (!closeResult.ok) {
					debugSession(
						"error closing old session during recovery: %s",
						closeResult.error.message,
					);
				}
			} catch (e) {
				debugSession("exception closing old session: %s", e);
			}
			this.session = undefined;
		}

		// Create new session
		await this.ensureSession();
		if (!this.session) {
			debugSession("failed to create new session during recovery");
			// Will retry on next pump iteration
			return;
		}

		// Store session in local variable to help TypeScript type narrowing
		const session: TransportAppendSession = this.session;

		// Resubmit all inflight entries (replace their innerPromise and reset attempt start)
		debugSession("resubmitting %d inflight entries", this.inflight.length);
		for (const entry of this.inflight) {
			// Attach .catch to superseded promise to avoid unhandled rejection
			entry.innerPromise.catch(() => {});

			// Create new promise from new session
			entry.attemptStartedMonotonicMs = performance.now();
			entry.innerPromise = session.submit(entry.records, entry.args);
		}

		debugSession("recovery complete");
	}

	/**
	 * Check if append can be retried under noSideEffects policy.
	 * For appends, idempotency requires match_seq_num.
	 */
	private isIdempotent(entry: InflightEntry): boolean {
		const args = entry.args;
		if (!args) return false;

		return args.match_seq_num !== undefined;
	}

	/**
	 * Ensure session exists, creating it if necessary.
	 */
	private async ensureSession(): Promise<void> {
		if (this.session) {
			return;
		}

		try {
			this.session = await this.generator(this.sessionOptions);
		} catch (e) {
			const error = s2Error(e);
			debugSession("failed to create session: %s", error.message);
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

		debugSession("aborting session: %s", error.message);

		this.fatalError = error;
		this.pumpStopped = true;

		// Resolve all inflight entries with error
		for (const entry of this.inflight) {
			if (entry.maybeResolve) {
				entry.maybeResolve(err(error));
			}
		}
		this.inflight.length = 0;
		this.queuedBytes = 0;
		this.pendingBytes = 0;

		// Error the readable stream
		try {
			this.acksController?.error(error);
		} catch (e) {
			debugSession("failed to error acks controller: %s", e);
		}

		// Wake capacity waiter to unblock any pending writer
		if (this.capacityWaiter) {
			this.capacityWaiter();
			this.capacityWaiter = undefined;
		}

		// Close inner session
		if (this.session) {
			try {
				await this.session.close();
			} catch (e) {
				debugSession("error closing session during abort: %s", e);
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

		debugSession("close requested");
		this.closing = true;

		// Wake pump if it's sleeping so it can check closing flag
		if (this.pumpWakeup) {
			this.pumpWakeup();
		}

		// Wait for pump to stop (drains inflight queue, including through recovery)
		if (this.pumpPromise) {
			await this.pumpPromise;
		}

		// Close inner session
		if (this.session) {
			try {
				const result = await this.session.close();
				if (!result.ok) {
					debugSession("error closing inner session: %s", result.error.message);
				}
			} catch (e) {
				debugSession("exception closing inner session: %s", e);
			}
			this.session = undefined;
		}

		// Close readable stream
		try {
			this.acksController?.close();
		} catch (e) {
			debugSession("error closing acks controller: %s", e);
		}

		this.closed = true;

		// If fatal error occurred, throw it
		if (this.fatalError) {
			throw this.fatalError;
		}

		debugSession("close complete");
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
	lastAckedPosition(): AppendAck | undefined {
		return this._lastAckedPosition;
	}
}
