import createDebug from "debug";
import type { RetryConfig } from "../common.js";
import { S2Error, s2Error, withS2Error } from "../error.js";
import type { AppendAck, StreamPosition } from "../generated/index.js";
import { meteredSizeBytes } from "../utils.js";
import type { AppendResult, CloseResult } from "./result.js";
import { err, errClose, ok, okClose } from "./result.js";
import type {
	AcksStream,
	AppendArgs,
	AppendRecord,
	AppendSession,
	AppendSessionOptions,
	ReadArgs,
	ReadRecord,
	ReadSession,
	TransportAppendSession,
	TransportReadSession,
} from "./stream/types.js";

const debug = createDebug("s2:retry");

/**
 * Default retry configuration.
 */
export const DEFAULT_RETRY_CONFIG: Required<RetryConfig> & {
	requestTimeoutMillis: number;
} = {
	maxAttempts: 3,
	retryBackoffDurationMs: 100,
	appendRetryPolicy: "noSideEffects",
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
 * Calculates the delay before the next retry attempt using exponential backoff.
 */
export function calculateDelay(attempt: number, baseDelayMs: number): number {
	// Exponential backoff: baseDelay * (2 ^ attempt)
	const delay = baseDelayMs * Math.pow(2, attempt);
	// Add jitter: random value between 0 and delay
	const jitter = Math.random() * delay;
	return Math.floor(delay + jitter);
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

	// If maxAttempts is 0, don't retry at all
	if (config.maxAttempts === 0) {
		debug("maxAttempts is 0, retries disabled");
		return fn();
	}

	let lastError: S2Error | undefined = undefined;

	for (let attempt = 0; attempt <= config.maxAttempts; attempt++) {
		try {
			const result = await fn();
			if (attempt > 0) {
				debug("succeeded after %d retries", attempt);
			}
			return result;
		} catch (error) {
			// withRetry only handles S2Errors (withS2Error should be called first)
			if (!(error instanceof S2Error)) {
				debug("non-S2Error thrown, rethrowing immediately: %s", error);
				throw error;
			}

			lastError = error;

			// Don't retry if this is the last attempt
			if (attempt === config.maxAttempts) {
				debug("max attempts exhausted, throwing error");
				break;
			}

			// Check if error is retryable
			if (!isPolicyCompliant(config, lastError) || !isRetryable(lastError)) {
				debug("error not retryable, throwing immediately");
				throw error;
			}

			// Calculate delay and wait before retrying
			const delay = calculateDelay(attempt, config.retryBackoffDurationMs);
			debug(
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
	implements ReadSession<Format>
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
		return new RetryReadSession<Format>(args, generator, config);
	}

	private constructor(
		args: ReadArgs<Format>,
		generator: (
			args: ReadArgs<Format>,
		) => Promise<TransportReadSession<Format>>,
		config?: RetryConfig,
	) {
		const retryConfig = {
			...DEFAULT_RETRY_CONFIG,
			...config,
		};
		let session: TransportReadSession<Format> | undefined = undefined;
		const startTimeMs = performance.now(); // Capture start time before super()
		super({
			start: async (controller) => {
				let nextArgs = { ...args };
				let attempt = 0;

				while (true) {
					session = await generator(nextArgs);
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
							if (isRetryable(error) && attempt < retryConfig.maxAttempts) {
								if (this._nextReadPosition) {
									nextArgs.seq_num = this._nextReadPosition.seq_num;
								}
								if (nextArgs.count) {
									nextArgs.count =
										this._recordsRead === undefined
											? nextArgs.count
											: nextArgs.count - this._recordsRead;
								}
								if (nextArgs.bytes) {
									nextArgs.bytes =
										this._bytesRead === undefined
											? nextArgs.bytes
											: nextArgs.bytes - this._bytesRead;
								}
								// Adjust wait to account for elapsed time.
								// If user specified wait=10s and we've already spent 5s (including backoff),
								// we should only wait another 5s on retry to honor the original time budget.
								if (nextArgs.wait !== undefined) {
									const elapsedSeconds =
										(performance.now() - startTimeMs) / 1000;
									nextArgs.wait = Math.max(0, nextArgs.wait - elapsedSeconds);
								}
								const delay = calculateDelay(
									attempt,
									retryConfig.retryBackoffDurationMs,
								);
								debug("will retry after %dms, status=%s", delay, error.status);
								await sleep(delay);
								attempt++;
								break; // Break inner loop to retry
							}

							// Error is not retryable or attempts exhausted
							debug("error in retry loop: %s", error);
							controller.error(error);
							return;
						}

						// Success: enqueue the record (don't reset attempt counter - track session attempts)
						const record = result.value;
						this._nextReadPosition = {
							seq_num: record.seq_num + 1,
							timestamp: record.timestamp,
						};
						this._recordsRead++;
						this._bytesRead += meteredSizeBytes(record);
						attempt = 0;

						controller.enqueue(record);
					}
				}
			},
			cancel: async () => {
				session?.cancel();
			},
		});
	}

	async [Symbol.asyncDispose]() {
		await this.cancel("disposed");
	}

	// Polyfill for older browsers / Node.js environments
	[Symbol.asyncIterator](): AsyncIterableIterator<ReadRecord<Format>> {
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

	lastObservedTail(): StreamPosition | undefined {
		return this._lastObservedTail;
	}

	nextReadPosition(): StreamPosition | undefined {
		return this._nextReadPosition;
	}
}

/**
 * RetryAppendSession wraps an underlying AppendSession with automatic retry logic.
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
 * - Acks arrive within ackTimeoutMs (5s) or session is retried
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
	enqueuedAt: number; // Timestamp for timeout anchoring
	innerPromise: Promise<AppendResult>; // Promise from transport session
	maybeResolve?: (result: AppendResult) => void; // Resolver for submit() callers
};

const DEFAULT_MAX_QUEUED_BYTES = 10 * 1024 * 1024; // 10 MiB default

export class RetryAppendSession implements AppendSession, AsyncDisposable {
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
		) => Promise<import("./stream/types.js").TransportAppendSession>,
		private readonly sessionOptions?: AppendSessionOptions,
		config?: RetryConfig,
	) {
		this.retryConfig = {
			...DEFAULT_RETRY_CONFIG,
			...config,
		};
		this.requestTimeoutMillis = this.retryConfig.requestTimeoutMillis;
		this.maxQueuedBytes =
			this.sessionOptions?.maxQueuedBytes ?? DEFAULT_MAX_QUEUED_BYTES;
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
					batchMeteredSize += meteredSizeBytes(record);
				}

				// Wait for capacity (backpressure for writable only)
				await this.waitForCapacity(batchMeteredSize);

				const args = { ...chunk } as Omit<AppendArgs, "records"> & {
					precalculatedSize?: number;
				};
				delete (args as any).records;
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
				const error = new S2Error({
					message: `AppendSession aborted: ${reason}`,
					status: 499,
				});
				await this.abort(error);
			},
		});
	}

	static async create(
		generator: (
			options?: AppendSessionOptions,
		) => Promise<import("./stream/types.js").TransportAppendSession>,
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
				batchMeteredSize += meteredSizeBytes(record);
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
			debug(
				"[SUBMIT] rejecting due to fatal error: %s",
				this.fatalError.message,
			);
			return Promise.resolve(err(this.fatalError));
		}

		// Create promise for submit() callers
		return new Promise<AppendResult>((resolve) => {
			// Create inflight entry (innerPromise will be set when pump processes it)
			const entry: InflightEntry & { __needsSubmit?: boolean } = {
				records,
				args,
				expectedCount: records.length,
				meteredBytes: batchMeteredSize,
				enqueuedAt: Date.now(),
				innerPromise: new Promise(() => {}), // Never-resolving placeholder
				maybeResolve: resolve,
				__needsSubmit: true, // Mark for pump to submit
			};

			debug(
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
		debug(
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
				debug(
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
					debug(
						"[CAPACITY] capacity available, adding %d to pendingBytes",
						bytes,
					);
					this.pendingBytes += bytes;
					return;
				}
			}

			// No capacity - wait
			// WritableStream enforces writer lock, so only one write can be blocked at a time
			debug("[CAPACITY] no capacity, waiting for release");
			await new Promise<void>((resolve) => {
				this.capacityWaiter = resolve;
			});
			debug("[CAPACITY] woke up, rechecking");
		}
	}

	/**
	 * Release capacity and wake waiter if present.
	 */
	private releaseCapacity(bytes: number): void {
		debug(
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
			debug("[CAPACITY] waking waiter");
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
			debug("pump crashed unexpectedly: %s", e);
			// This should never happen - pump handles all errors internally
		});
	}

	/**
	 * Main pump loop: processes inflight queue, handles acks, retries, and recovery.
	 */
	private async runPump(): Promise<void> {
		debug("pump started");

		while (true) {
			debug(
				"[PUMP] loop: inflight=%d, queuedBytes=%d, pendingBytes=%d, closing=%s, pumpStopped=%s",
				this.inflight.length,
				this.queuedBytes,
				this.pendingBytes,
				this.closing,
				this.pumpStopped,
			);

			// Check if we should stop
			if (this.pumpStopped) {
				debug("[PUMP] stopped by flag");
				return;
			}

			// If closing and queue is empty, stop
			if (this.closing && this.inflight.length === 0) {
				debug("[PUMP] closing and queue empty, stopping");
				this.pumpStopped = true;
				return;
			}

			// If no entries, sleep and continue
			if (this.inflight.length === 0) {
				debug("[PUMP] no entries, sleeping 10ms");
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
			debug(
				"[PUMP] processing head: expectedCount=%d, meteredBytes=%d, enqueuedAt=%d",
				head.expectedCount,
				head.meteredBytes,
				head.enqueuedAt,
			);

			// Ensure session exists
			debug("[PUMP] ensuring session exists");
			await this.ensureSession();
			if (!this.session) {
				// Session creation failed - will retry
				debug("[PUMP] session creation failed, sleeping 100ms");
				await sleep(100);
				continue;
			}

			// Submit ALL entries that need submitting (enables HTTP/2 pipelining for S2S)
			for (const entry of this.inflight) {
				if (!entry.innerPromise || (entry as any).__needsSubmit) {
					debug(
						"[PUMP] submitting entry to inner session (%d records, %d bytes)",
						entry.expectedCount,
						entry.meteredBytes,
					);
					entry.innerPromise = this.session.submit(entry.records, entry.args);
					delete (entry as any).__needsSubmit;
				}
			}

			// Wait for head with timeout
			debug("[PUMP] waiting for head result");
			const result = await this.waitForHead(head);
			debug("[PUMP] got result: kind=%s", result.kind);

			if (result.kind === "timeout") {
				// Ack timeout - fatal
				const elapsed = Date.now() - head.enqueuedAt;
				const error = new S2Error({
					message: `Request timeout after ${elapsed}ms (${head.expectedCount} records, ${head.meteredBytes} bytes, enqueued at ${new Date(head.enqueuedAt).toISOString()})`,
					status: 408,
					code: "REQUEST_TIMEOUT",
				});
				debug("ack timeout for head entry: %s", error.message);
				await this.abort(error);
				return;
			}

			// Promise settled
			const appendResult = result.value;

			if (appendResult.ok) {
				// Success!
				const ack = appendResult.value;
				debug("[PUMP] success, got ack", { ack });

				// Invariant check: ack count matches batch count
				const ackCount = Number(ack.end.seq_num) - Number(ack.start.seq_num);
				if (ackCount !== head.expectedCount) {
					const error = new S2Error({
						message: `Ack count mismatch: expected ${head.expectedCount}, got ${ackCount}`,
						status: 500,
						code: "INTERNAL_ERROR",
					});
					debug("invariant violation: %s", error.message);
					await this.abort(error);
					return;
				}

				// Invariant check: sequence numbers must be strictly increasing
				if (this._lastAckedPosition) {
					const prevEnd = BigInt(this._lastAckedPosition.end.seq_num);
					const currentEnd = BigInt(ack.end.seq_num);
					if (currentEnd <= prevEnd) {
						const error = new S2Error({
							message: `Sequence number not strictly increasing: previous=${prevEnd}, current=${currentEnd}`,
							status: 500,
							code: "INTERNAL_ERROR",
						});
						debug("invariant violation: %s", error.message);
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
					debug("failed to enqueue ack: %s", e);
				}

				// Remove from inflight and release capacity
				debug(
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
				debug(
					"[PUMP] error: status=%s, message=%s",
					error.status,
					error.message,
				);

				// Check if retryable
				if (!isRetryable(error)) {
					debug("error not retryable, aborting");
					await this.abort(error);
					return;
				}

				// Check policy compliance
				if (
					this.retryConfig.appendRetryPolicy === "noSideEffects" &&
					!this.isAppendRetryAllowed(head)
				) {
					debug("error not policy-compliant (noSideEffects), aborting");
					await this.abort(error);
					return;
				}

				// Check max attempts
				if (this.currentAttempt >= this.retryConfig.maxAttempts) {
					debug(
						"max attempts reached (%d), aborting",
						this.retryConfig.maxAttempts,
					);
					const wrappedError = new S2Error({
						message: `Max retry attempts (${this.retryConfig.maxAttempts}) exceeded: ${error.message}`,
						status: error.status,
						code: error.code,
					});
					await this.abort(wrappedError);
					return;
				}

				// Perform recovery
				this.consecutiveFailures++;
				this.currentAttempt++;

				debug(
					"performing recovery (attempt %d/%d)",
					this.currentAttempt,
					this.retryConfig.maxAttempts,
				);

				await this.recover();
			}
		}
	}

	/**
	 * Wait for head entry's innerPromise with timeout.
	 * Returns either the settled result or a timeout indicator.
	 */
	private async waitForHead(
		head: InflightEntry,
	): Promise<{ kind: "settled"; value: AppendResult } | { kind: "timeout" }> {
		const deadline = head.enqueuedAt + this.requestTimeoutMillis;
		const remaining = Math.max(0, deadline - Date.now());

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
		debug("starting recovery");

		// Calculate backoff delay
		const delay = calculateDelay(
			this.consecutiveFailures - 1,
			this.retryConfig.retryBackoffDurationMs,
		);
		debug("backing off for %dms", delay);
		await sleep(delay);

		// Teardown old session
		if (this.session) {
			try {
				const closeResult = await this.session.close();
				if (!closeResult.ok) {
					debug(
						"error closing old session during recovery: %s",
						closeResult.error.message,
					);
				}
			} catch (e) {
				debug("exception closing old session: %s", e);
			}
			this.session = undefined;
		}

		// Create new session
		await this.ensureSession();
		if (!this.session) {
			debug("failed to create new session during recovery");
			// Will retry on next pump iteration
			return;
		}

		// Store session in local variable to help TypeScript type narrowing
		const session: TransportAppendSession = this.session;

		// Resubmit all inflight entries (replace their innerPromise)
		debug("resubmitting %d inflight entries", this.inflight.length);
		for (const entry of this.inflight) {
			// Attach .catch to superseded promise to avoid unhandled rejection
			entry.innerPromise.catch(() => {});

			// Create new promise from new session
			entry.innerPromise = session.submit(entry.records, entry.args);
		}

		debug("recovery complete");
	}

	/**
	 * Check if append can be retried under noSideEffects policy.
	 */
	private isAppendRetryAllowed(entry: InflightEntry): boolean {
		const args = entry.args;
		if (!args) return false;

		// Allow retry if match_seq_num or fencing_token is set (idempotent)
		return args.match_seq_num !== undefined || args.fencing_token !== undefined;
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
			debug("failed to create session: %s", error.message);
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

		debug("aborting session: %s", error.message);

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
			debug("failed to error acks controller: %s", e);
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
				debug("error closing session during abort: %s", e);
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

		debug("close requested");
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
					debug("error closing inner session: %s", result.error.message);
				}
			} catch (e) {
				debug("exception closing inner session: %s", e);
			}
			this.session = undefined;
		}

		// Close readable stream
		try {
			this.acksController?.close();
		} catch (e) {
			debug("error closing acks controller: %s", e);
		}

		this.closed = true;

		// If fatal error occurred, throw it
		if (this.fatalError) {
			throw this.fatalError;
		}

		debug("close complete");
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
