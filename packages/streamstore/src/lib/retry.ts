import createDebug from "debug";
import type { RetryConfig } from "../common.js";
import {
	abortedError,
	abortedFromReason,
	appendSessionClosedError,
	invariantViolation,
	isServerDraining,
	RECONNECT_ADVISED_CODE,
	S2Error,
	s2Error,
	withPriorUncertainty,
	withS2Error,
} from "../error.js";
import type * as API from "../generated/index.js";
import * as Types from "../types.js";
import { isCommandRecord, meteredBytes } from "../utils.js";
import { FifoQueue } from "./queue.js";
import type { AppendResult, CloseResult } from "./result.js";
import { err, errClose, ok, okClose } from "./result.js";
import {
	type CaughtUpBoundary,
	CaughtUpTracker,
} from "./stream/caught-up-tracker.js";
import type { OpenSessions } from "./stream/open-sessions.js";
import type {
	AcksStream,
	AppendRecord,
	AppendSessionOptions,
	AppendSession as AppendSessionType,
	ReadArgs,
	ReadRecord,
	ReadSession as ReadSessionType,
	TransportAppendSession,
	TransportReadEvent,
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
 * Convert internal ReadRecord to SDK ReadRecord.
 * Headers are always an array of tuples from both S2S and fetch transports.
 */
function toSDKReadRecord<Format extends "string" | "bytes">(
	record: ReadRecord<Format>,
	format: Format,
): Types.ReadRecord<Format> {
	return {
		seqNum: record.seq_num,
		timestamp: new Date(record.timestamp),
		body: (record.body ??
			(format === "string"
				? ""
				: new Uint8Array())) as Types.ReadRecord<Format>["body"],
		headers: (record.headers ?? []) as Types.ReadRecord<Format>["headers"],
	} as Types.ReadRecord<Format>;
}

/**
 * Default retry configuration.
 */
export const DEFAULT_RETRY_CONFIG: Required<RetryConfig> = {
	maxAttempts: 3,
	minBaseDelayMillis: 100,
	maxBaseDelayMillis: 1000,
	appendRetryPolicy: "all",
	requestTimeoutMillis: 5000, // 5 seconds
	connectionTimeoutMillis: 3000, // 3 seconds
};

const RETRYABLE_STATUS_CODES = new Set([
	408, // request_timeout
	429, // too_many_requests
	500, // internal_server_error
	502, // bad_gateway
	503, // service_unavailable
	504, // gateway_timeout
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

	// Transaction conflicts are transiently retryable
	if (error.status === 409 && error.code === "transaction_conflict") {
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
 *   baseDelay = min(minBaseDelayMillis * 2^attempt, maxBaseDelayMillis)
 *   jitter = random(0, baseDelay)
 *   delay = baseDelay + jitter
 *
 * @param attempt - Zero-based retry attempt number (0 = first retry)
 * @param minBaseDelayMillis - Minimum delay for exponential backoff
 * @param maxBaseDelayMillis - Maximum base delay (actual delay can be up to 2x with jitter)
 */
export function calculateDelay(
	attempt: number,
	minBaseDelayMillis: number,
	maxBaseDelayMillis: number,
): number {
	// Calculate exponential backoff: minDelay * 2^attempt, capped at maxDelay
	const baseDelay = Math.min(
		minBaseDelayMillis * Math.pow(2, attempt),
		maxBaseDelayMillis,
	);

	// Add jitter: random value in [0, baseDelay)
	const jitter = Math.random() * baseDelay;

	// Total delay is base + jitter
	return Math.floor(baseDelay + jitter);
}

/**
 * Sleeps for the specified duration, or until `signal` aborts.
 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		if (signal?.aborted) {
			resolve();
			return;
		}
		const wake = () => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", wake);
			resolve();
		};
		const timer = setTimeout(wake, ms);
		signal?.addEventListener("abort", wake);
	});
}

/**
 * Executes an async function with automatic retry logic for transient failures.
 *
 * @param retryConfig Retry configuration (max attempts, backoff duration)
 * @param fn The async function to execute
 * @param isPolicyCompliant Additional per-error retry gate (append retry policy)
 * @param trackAppendUncertainty When set, remember that a retried attempt may
 *   have taken effect so a later definite error is not reported as side-effect free
 * @returns The result of the function
 * @throws The last error if all retry attempts are exhausted
 */
export async function withRetries<T>(
	retryConfig: RetryConfig | undefined,
	fn: () => Promise<T>,
	isPolicyCompliant: (config: RetryConfig, error: S2Error) => boolean = () =>
		true,
	trackAppendUncertainty: boolean = false,
): Promise<T> {
	const config = {
		...DEFAULT_RETRY_CONFIG,
		...retryConfig,
	};

	// Enforce minimum of 1 attempt (1 = no retries)
	if (config.maxAttempts < 1) config.maxAttempts = 1;

	let lastError: S2Error | undefined = undefined;
	let priorUncertainty = false;

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
				throw withPriorUncertainty(error, priorUncertainty);
			}

			if (trackAppendUncertainty && !error.hasNoSideEffects()) {
				priorUncertainty = true;
			}

			// Calculate delay and wait before retrying
			const delay = calculateDelay(
				attemptNo - 1,
				config.minBaseDelayMillis,
				config.maxBaseDelayMillis,
			);
			debugWith(
				"retryable error, backing off for %dms, status=%s",
				delay,
				error.status,
			);
			await sleep(delay);
		}
	}

	if (lastError !== undefined) {
		throw withPriorUncertainty(lastError, priorUncertainty);
	}
	throw lastError;
}

/** What ends a session early: its caller's signal, or its transport closing. */
type SessionOptions = { signal?: AbortSignal; sessions?: OpenSessions };

/**
 * Calls `onAbort` when `options.signal` aborts, or throws {@link abortedError}
 * if it already has, and `onClose` when `options.sessions` close. Returns a
 * function that detaches both.
 */
function attachSession(
	options: SessionOptions | undefined,
	onAbort: () => void,
	onClose: () => unknown = onAbort,
): () => void {
	const signal = options?.signal;
	if (signal?.aborted) {
		throw abortedError();
	}
	const unregister = options?.sessions?.register(onClose);
	signal?.addEventListener("abort", onAbort);
	return () => {
		signal?.removeEventListener("abort", onAbort);
		unregister?.();
	};
}

/** Opens a transport read session. `signal` aborts when the session ends early. */
type ReadSessionGenerator<Format extends "string" | "bytes"> = (
	args: ReadArgs<Format>,
	signal: AbortSignal,
) => Promise<TransportReadSession<Format>>;

type ReadDelivery<Format extends "string" | "bytes"> = {
	records: Types.ReadRecord<Format>[];
	next: number;
	boundary?: CaughtUpBoundary;
	onDrained?: () => void;
};

export class RetryReadSession<Format extends "string" | "bytes" = "string">
	extends ReadableStream<Types.ReadRecord<Format>>
	implements ReadSessionType<Format>
{
	private _nextReadPosition: API.StreamPosition | undefined = undefined;
	private _lastObservedTail: API.StreamPosition | undefined = undefined;
	private _lastTailAtMs: number | undefined = undefined;

	private _recordsRead: number = 0;
	private _bytesRead: number = 0;

	private readonly caughtUpTracker: CaughtUpTracker;
	private readonly abortController: AbortController;

	/**
	 * Open a read session. The transport session is created eagerly, so
	 * `create` rejects if it cannot connect.
	 *
	 * Once `options.signal` aborts, at any point, the session ends with
	 * {@link abortedError}: `create` rejects with it, or reads throw it.
	 * An abort is never retried. Closing `options.sessions` aborts the
	 * session the same way.
	 */
	static async create<Format extends "string" | "bytes" = "string">(
		generator: ReadSessionGenerator<Format>,
		args: ReadArgs<Format> = {},
		config?: RetryConfig,
		options?: SessionOptions,
	) {
		const snapshotArgs: ReadArgs<Format> = {
			...args,
			stream_config: Types.cloneStreamConfig(args.stream_config),
		};
		const retryConfig = {
			...DEFAULT_RETRY_CONFIG,
			...config,
		};

		// Ends this session. Transport attempts get its signal so an abort
		// also cancels a request that is still connecting.
		const abort = new AbortController();
		const release = attachSession(options, () => abort.abort());

		try {
			let attempt = 0;
			while (true) {
				if (abort.signal.aborted) {
					throw abortedError();
				}
				let session: TransportReadSession<Format>;
				try {
					session = await generator(snapshotArgs, abort.signal);
				} catch (err) {
					if (abort.signal.aborted) {
						throw abortedError();
					}
					const error = s2Error(err);
					const draining = isServerDraining(error);

					const effectiveMax = Math.max(1, retryConfig.maxAttempts);
					if (isRetryable(error) && (draining || attempt < effectiveMax - 1)) {
						const delay = draining
							? 0
							: calculateDelay(
									attempt,
									retryConfig.minBaseDelayMillis,
									retryConfig.maxBaseDelayMillis,
								);
						debugRead(
							"connection error in create, will retry after %dms, status=%s",
							delay,
							error.status,
						);
						await sleep(delay, abort.signal);
						if (!draining) {
							attempt++;
						}
						continue;
					}

					// Not retryable or attempts exhausted
					throw error;
				}
				if (abort.signal.aborted) {
					await session.cancel("aborted").catch(() => {});
					throw abortedError();
				}
				return new RetryReadSession<Format>(
					snapshotArgs,
					generator,
					config,
					session,
					abort,
					release,
				);
			}
		} catch (err) {
			release();
			throw err;
		}
	}

	private constructor(
		args: ReadArgs<Format>,
		generator: ReadSessionGenerator<Format>,
		config: RetryConfig | undefined,
		initialSession: TransportReadSession<Format>,
		abort: AbortController,
		release: () => void,
	) {
		const abortSignal = abort.signal;
		const retryConfig = {
			...DEFAULT_RETRY_CONFIG,
			...config,
		};
		const format = (args?.as ?? "string") as Format;
		const caughtUpTracker = new CaughtUpTracker();
		let session: TransportReadSession<Format> | undefined = initialSession;
		let currentReader:
			| ReadableStreamDefaultReader<TransportReadEvent<Format>>
			| undefined;
		let cancelled = false;
		const deliveries = new FifoQueue<ReadDelivery<Format>>();
		let wakePull: (() => void) | undefined;
		let resolvePendingDelivery: (() => void) | undefined;
		let pumpDone = false;
		let pumpError: S2Error | undefined;
		// The pump stops quietly: a cancel needs no error, and an abort has
		// already failed the pump.
		const stopped = () => cancelled || abortSignal.aborted;

		const wake = () => {
			const resolve = wakePull;
			wakePull = undefined;
			resolve?.();
		};
		const enqueueBatch = async (
			records: Types.ReadRecord<Format>[],
			boundary?: CaughtUpBoundary,
		) => {
			if (!boundary) {
				if (records.length > 0) {
					deliveries.push({ records, next: 0 });
					wake();
				}
				return;
			}
			await new Promise<void>((onDrained) => {
				resolvePendingDelivery = onDrained;
				if (records.length === 0 && deliveries.length === 0) {
					boundary.markDelivered();
					onDrained();
					return;
				}
				deliveries.push({
					records,
					next: 0,
					boundary,
					onDrained,
				});
				wake();
			});
			resolvePendingDelivery = undefined;
		};
		const failPump = (
			error: S2Error,
			options?: { discardBuffered?: boolean },
		) => {
			if (!options?.discardBuffered && pumpError) {
				return;
			}
			if (options?.discardBuffered) {
				deliveries.clear();
			}
			caughtUpTracker.end(error);
			pumpError = error;
			resolvePendingDelivery?.();
			wake();
			if (options?.discardBuffered) {
				release();
			}
		};
		const handlePumpError = (error: unknown) => {
			if (!cancelled) {
				failPump(s2Error(error));
			}
		};
		const cancelTransport = async (reason: unknown) => {
			try {
				// Cancel through the locked reader so the transport stream closes.
				if (currentReader) {
					await currentReader.cancel(reason);
				} else {
					await session?.cancel(reason);
				}
			} catch (err) {
				if (!hasErrorCode(err, "ERR_INVALID_STATE")) {
					throw err;
				}
			}
		};
		// Also after the pump is done or failed: records it fetched may still be unread.
		abortSignal.addEventListener("abort", () => {
			if (cancelled) {
				return;
			}
			failPump(abortedError(), { discardBuffered: true });
			void cancelTransport("aborted").catch(() => {});
		});

		const pump = async () => {
			let nextArgs = { ...args } as ReadArgs<Format>;
			const baselineCount = args?.count;
			const baselineBytes = args?.bytes;
			const baselineWait = args?.wait;
			let attempt = 0;

			while (true) {
				if (stopped()) {
					return;
				}

				if (!session) {
					debugRead("starting read session with args: %o", nextArgs);

					try {
						session = await generator(nextArgs, abortSignal);
						if (stopped()) {
							try {
								await session.cancel?.("cancelled");
							} catch {}
							return;
						}
					} catch (err) {
						if (stopped()) {
							return;
						}
						const error = s2Error(err);
						const draining = isServerDraining(error);

						const effectiveMax = Math.max(1, retryConfig.maxAttempts);
						if (
							isRetryable(error) &&
							(draining || attempt < effectiveMax - 1)
						) {
							const delay = draining
								? 0
								: calculateDelay(
										attempt,
										retryConfig.minBaseDelayMillis,
										retryConfig.maxBaseDelayMillis,
									);
							debugRead(
								"connection error, will retry after %dms, status=%s",
								delay,
								error.status,
							);
							await sleep(delay, abortSignal);
							if (!draining) {
								attempt++;
							}
							continue;
						}

						debugRead("connection error not retryable: %s", error);
						failPump(error);
						return;
					}
				}

				const reader = session.getReader();
				currentReader = reader;

				while (true) {
					if (stopped()) {
						return;
					}
					let read: Awaited<ReturnType<typeof reader.read>>;
					try {
						read = await reader.read();
					} catch (err) {
						const error = s2Error(err);
						debugRead(
							"transport stream threw, normalized status=%d code=%s origin=%s message=%s",
							error.status,
							error.code,
							error.origin,
							error.message,
						);
						read = {
							done: false,
							value: { ok: false, error },
						};
					}
					if (abortSignal.aborted) {
						return;
					}
					const { done, value: result } = read;
					try {
						const tail = session.lastObservedTail?.();
						if (tail) {
							this._lastObservedTail = tail;
							this._lastTailAtMs = performance.now();
						}
					} catch {}
					if (done || cancelled) {
						reader.releaseLock();
						currentReader = undefined;
						caughtUpTracker.end();
						pumpDone = true;
						wake();
						return;
					}

					if (!result.ok) {
						reader.releaseLock();
						currentReader = undefined;
						const error = result.error;

						// Planned drain handoffs do not consume retry attempts.
						const draining =
							error.code === RECONNECT_ADVISED_CODE || isServerDraining(error);
						const effectiveMax = Math.max(1, retryConfig.maxAttempts);
						if (
							isRetryable(error) &&
							(draining || attempt < effectiveMax - 1)
						) {
							const retryFromSeqNum =
								this._nextReadPosition?.seq_num ?? nextArgs.seq_num;
							if (this._nextReadPosition) {
								nextArgs.seq_num = this._nextReadPosition.seq_num;
								// Only one start position may be set.
								delete nextArgs.timestamp;
								delete nextArgs.tail_offset;
							}
							const delay = draining
								? 0
								: calculateDelay(
										attempt,
										retryConfig.minBaseDelayMillis,
										retryConfig.maxBaseDelayMillis,
									);
							if (baselineCount !== undefined) {
								nextArgs.count = Math.max(0, baselineCount - this._recordsRead);
							}
							if (baselineBytes !== undefined) {
								nextArgs.bytes = Math.max(0, baselineBytes - this._bytesRead);
							}
							// Avoid a useless reconnect for a read that was already
							// satisfied when the advice arrived.
							if (draining && (nextArgs.count === 0 || nextArgs.bytes === 0)) {
								debugRead("read limits reached on server advice");
								try {
									await session.cancel?.("limits reached");
								} catch {}
								session = undefined;
								caughtUpTracker.end();
								pumpDone = true;
								wake();
								return;
							}
							// After observing a tail, subtract elapsed time and retry delay.
							if (baselineWait !== undefined) {
								if (this._lastTailAtMs !== undefined) {
									const elapsedSeconds =
										(performance.now() - this._lastTailAtMs) / 1000;
									nextArgs.wait = Math.max(
										0,
										Math.floor(baselineWait - (elapsedSeconds + delay / 1000)),
									);
								} else {
									nextArgs.wait = baselineWait;
								}
							}
							caughtUpTracker.reconnect();

							try {
								await session.cancel?.("retry");
							} catch {}

							session = undefined;

							if (draining) {
								debugRead(
									"reconnecting read session while server drains, next_seq_num=%s records_read=%d",
									retryFromSeqNum ?? "unknown",
									this._recordsRead,
								);
							} else {
								debugRead(
									"will retry after %dms, status=%s code=%s attempt=%d/%d next_seq_num=%s records_read=%d",
									delay,
									error.status,
									error.code,
									attempt + 1,
									effectiveMax - 1,
									retryFromSeqNum ?? "unknown",
									this._recordsRead,
								);
							}
							await sleep(delay, abortSignal);
							if (!draining) {
								attempt++;
							}
							break;
						}

						debugRead("error in retry loop: %s", error);
						failPump(error);
						return;
					}

					const { records, tail } = result.batch;
					// Any batch — records or an empty heartbeat tail — proves the
					// session is healthy and restores the retry budget.
					attempt = 0;
					const lastRecord = records.at(-1);
					const boundary = caughtUpTracker.observeBatch({
						recordCount: records.length,
						lastSeqNum: lastRecord?.seq_num,
						tail: tail ? toSDKStreamPosition(tail) : undefined,
					});
					// An empty batch with a tail still resolves a timestamp or
					// tail-relative start. Anchoring here keeps a reconnect from
					// evaluating the original start against a newer tail and
					// skipping or re-reading records appended in between.
					if (records.length === 0 && tail) {
						this._nextReadPosition = {
							seq_num: tail.seq_num,
							timestamp: tail.timestamp,
						};
					}
					const visibleRecords: Types.ReadRecord<Format>[] = [];
					for (const record of records) {
						this._nextReadPosition = {
							seq_num: record.seq_num + 1,
							timestamp: record.timestamp,
						};
						this._recordsRead++;
						this._bytesRead += meteredBytes(record);
						if (!(args?.ignore_command_records && isCommandRecord(record))) {
							visibleRecords.push(toSDKReadRecord(record, format));
						}
					}
					await enqueueBatch(visibleRecords, boundary);
				}
			}
		};
		const finishDelivery = (delivery: ReadDelivery<Format>) => {
			delivery.boundary?.markDelivered();
			delivery.onDrained?.();
		};

		super(
			{
				start: () => {
					queueMicrotask(() => void pump().catch(handlePumpError));
				},
				pull: async (controller) => {
					while (!cancelled) {
						if (abortSignal.aborted) {
							controller.error(pumpError ?? abortedError());
							return;
						}
						const delivery = deliveries.peek();
						if (delivery) {
							let delivered = false;
							if (delivery.next < delivery.records.length) {
								controller.enqueue(delivery.records[delivery.next++]!);
								delivered = true;
							}
							if (delivery.next === delivery.records.length) {
								deliveries.shift();
								finishDelivery(delivery);
							}
							if (delivered) {
								while (deliveries.peek()?.records.length === 0) {
									finishDelivery(deliveries.shift()!);
								}
								return;
							}
							continue;
						}
						if (pumpError) {
							controller.error(pumpError);
							release();
							return;
						}
						if (pumpDone) {
							controller.close();
							release();
							return;
						}
						await new Promise<void>((resolve) => {
							wakePull = resolve;
						});
					}
				},
				cancel: async (reason) => {
					cancelled = true;
					caughtUpTracker.end();
					pumpDone = true;
					deliveries.clear();
					resolvePendingDelivery?.();
					resolvePendingDelivery = undefined;
					wake();
					release();
					await cancelTransport(reason);
				},
			},
			{ highWaterMark: 0 },
		);
		this.caughtUpTracker = caughtUpTracker;
		this.abortController = abort;
	}

	async [Symbol.asyncDispose]() {
		// A locked stream can't be cancelled, so abort the session instead.
		if (this.locked) {
			this.abortController.abort();
			return;
		}
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

	isCaughtUp(): boolean {
		return this.caughtUpTracker.isCaughtUp();
	}

	caughtUp(): Promise<Types.StreamPosition> {
		return this.caughtUpTracker.caughtUp();
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
	settle: (result: AppendResult) => void; // Settles the submit() ticket's ack
	sent: boolean; // May have reached the server in the current attempt
	priorUncertainty: boolean; // An earlier attempt may have taken effect
};

const MIN_MAX_INFLIGHT_BYTES = 1 * 1024 * 1024; // 1 MiB minimum
const DEFAULT_MAX_INFLIGHT_BYTES = 3 * 1024 * 1024; // 3 MiB default

/** How waiting for the head entry ends. */
type HeadResult =
	| { kind: "settled"; value: AppendResult }
	| { kind: "timeout" }
	| { kind: "stopped" };

type CapacityWaiter = {
	input: Types.AppendInput;
	resolve: (ticket: BatchSubmitTicket) => void;
	reject: (error: S2Error) => void;
};

export class RetryAppendSession implements AsyncDisposable, AppendSessionType {
	private readonly requestTimeoutMillis: number;
	private readonly maxQueuedBytes: number;
	private readonly maxInflightBatches?: number;
	private readonly retryConfig: Required<RetryConfig> & {
		requestTimeoutMillis: number;
	};

	private readonly inflight = new FifoQueue<InflightEntry>();
	// Entries to send on the current session, in order; drained by the pump.
	private readonly toSubmit = new FifoQueue<InflightEntry>();
	// Submits waiting for capacity, enqueued in order as it frees up.
	private readonly capacityWaiters = new FifoQueue<CapacityWaiter>();

	private session?: TransportAppendSession;
	private queuedBytes = 0;
	private consecutiveFailures = 0;
	private currentAttempt = 0;

	private pumpPromise?: Promise<void>;
	// Aborted when the pump stops for good, cutting any backoff short.
	private readonly stopped = new AbortController();
	private closing = false;
	private pumpWakeup?: () => void;
	private closed = false;
	private abortPromise?: Promise<void>;
	private closePromise?: Promise<void>;
	private fatalError?: S2Error;

	private _lastAckedPosition?: Types.AppendAck;
	private acksController?: ReadableStreamDefaultController<Types.AppendAck>;
	// Detaches the session from its transport and the caller's signal.
	private readonly release: () => void;

	public readonly readable: ReadableStream<Types.AppendAck>;
	public readonly writable: WritableStream<Types.AppendInput>;

	private readonly streamName: string;

	private get pumpStopped(): boolean {
		return this.stopped.signal.aborted;
	}

	/**
	 * The error the session failed with, as the acks stream and `close()`
	 * report it, or undefined. It is an {@link AppendIndefiniteFailureError} if
	 * an earlier attempt may have applied an inflight append.
	 */
	failureCause(): S2Error | undefined {
		return this.fatalError;
	}

	private readonly sessionOptions?: AppendSessionOptions;

	constructor(
		private readonly generator: (
			options?: AppendSessionOptions,
		) => Promise<TransportAppendSession>,
		sessionOptions?: AppendSessionOptions,
		config?: RetryConfig,
		streamName?: string,
		options?: SessionOptions,
	) {
		this.sessionOptions = Types.cloneAppendSessionOptions(sessionOptions);
		this.streamName = streamName ?? "unknown";
		this.retryConfig = {
			...DEFAULT_RETRY_CONFIG,
			...config,
		};
		this.requestTimeoutMillis = this.retryConfig.requestTimeoutMillis;
		// Validate maxInflightBytes is finite and at least 1 MiB.
		const configuredBytes =
			this.sessionOptions?.maxInflightBytes ?? DEFAULT_MAX_INFLIGHT_BYTES;
		if (
			!Number.isFinite(configuredBytes) ||
			configuredBytes < MIN_MAX_INFLIGHT_BYTES
		) {
			throw new S2Error({
				message: `maxInflightBytes must be a finite number at least 1 MiB (${MIN_MAX_INFLIGHT_BYTES} bytes), got ${configuredBytes}`,
				origin: "sdk",
			});
		}
		this.maxQueuedBytes = configuredBytes;
		// Clamp maxInflightBatches to at least 1 if set
		this.maxInflightBatches =
			this.sessionOptions?.maxInflightBatches !== undefined
				? Math.max(1, this.sessionOptions.maxInflightBatches)
				: undefined;

		this.readable = new ReadableStream<Types.AppendAck>({
			start: (controller) => {
				this.acksController = controller;
			},
			cancel: async (reason) => {
				await this.abort(
					abortedFromReason("AppendSession acks cancelled", reason),
				);
			},
		});

		const abortFromWritable = (reason: unknown) =>
			this.abort(abortedFromReason("AppendSession aborted", reason));

		this.writable = new WritableStream<Types.AppendInput>({
			start: (controller) => {
				// controller.signal aborts immediately even while sink.write() is
				// blocked on submit() capacity, whereas sink.abort() waits for it.
				controller.signal?.addEventListener(
					"abort",
					() => {
						void abortFromWritable(controller.signal.reason);
					},
					{ once: true },
				);
			},
			write: async (chunk) => {
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
				await abortFromWritable(reason);
			},
		});

		this.release = attachSession(
			options,
			() =>
				void this.abort(
					abortedError("Request cancelled", options?.signal?.reason),
				),
			() => this.close(),
		);
	}

	/**
	 * Create an append session. Closing `options.sessions` closes it as
	 * {@link RetryAppendSession.close} does. Aborting `options.signal` fails it
	 * with {@link abortedError}, without retrying; `create` rejects if the
	 * signal has already aborted. As after any failure, appends it never sent
	 * and later ones reject with {@link appendSessionClosedError}.
	 */
	static async create(
		generator: (
			options?: AppendSessionOptions,
		) => Promise<TransportAppendSession>,
		sessionOptions?: AppendSessionOptions,
		config?: RetryConfig,
		streamName?: string,
		options?: SessionOptions,
	): Promise<RetryAppendSession> {
		return new RetryAppendSession(
			generator,
			sessionOptions,
			config,
			streamName,
			options,
		);
	}

	/**
	 * Submit an append request.
	 * Returns a promise that resolves to a submit ticket once the batch is enqueued (has capacity).
	 * The ticket's ack() can be awaited to get the AppendAck once the batch is durable.
	 * This method applies backpressure and will block if capacity limits are reached.
	 */
	async submit(input: Types.AppendInput): Promise<BatchSubmitTicket> {
		if (this.fatalError || this.closing) {
			throw appendSessionClosedError(this.fatalError);
		}
		// Validate, compute real meteredBytes, and copy mutable Uint8Array/Date inputs.
		const snapshot = Types.snapshotAppendInput(input);

		// This needs to happen in the sync path.
		this.ensurePump();

		// Behind any earlier submit still waiting, so batches keep their order.
		if (this.capacityWaiters.length === 0 && this.hasCapacity(snapshot)) {
			return this.enqueue(snapshot);
		}
		debugSession(
			"[%s] [CAPACITY] no capacity, waiting for release",
			this.streamName,
		);
		return new Promise((resolve, reject) => {
			this.capacityWaiters.push({ input: snapshot, resolve, reject });
		});
	}

	private hasCapacity(input: Types.AppendInput): boolean {
		// Admit any batch into an empty session, so one larger than
		// maxInflightBytes reaches the transport and fails, rather than waiting
		// forever and blocking every later submit.
		if (this.inflight.length === 0) {
			return true;
		}
		return (
			this.queuedBytes + input.meteredBytes <= this.maxQueuedBytes &&
			(this.maxInflightBatches === undefined ||
				this.inflight.length < this.maxInflightBatches)
		);
	}

	/** Reserve capacity for `input` and queue it for the pump, in one step. */
	private enqueue(input: Types.AppendInput): BatchSubmitTicket {
		const bytes = input.meteredBytes;
		debugSession(
			"[%s] [SUBMIT] enqueueing %d records (%d bytes), match_seq_num=%s: inflight=%d->%d, queuedBytes=%d->%d",
			this.streamName,
			input.records.length,
			bytes,
			input.matchSeqNum ?? "none",
			this.inflight.length,
			this.inflight.length + 1,
			this.queuedBytes,
			this.queuedBytes + bytes,
		);

		const ack = new Promise<Types.AppendAck>((resolve, reject) => {
			const entry: InflightEntry = {
				input,
				expectedCount: input.records.length,
				innerPromise: new Promise(() => {}), // Never-resolving placeholder
				settle: (result) =>
					result.ok ? resolve(result.value) : reject(result.error),
				sent: false,
				priorUncertainty: false,
			};
			this.inflight.push(entry);
			this.toSubmit.push(entry);
		});
		this.queuedBytes += bytes;
		// Prevent early rejections from surfacing as unhandled when callers delay ack()
		ack.catch(() => {});

		this.pumpWakeup?.();
		return new BatchSubmitTicket(ack, bytes, input.records.length);
	}

	/** Release an acked batch's capacity, enqueueing waiting submits in order. */
	private releaseCapacity(bytes: number): void {
		debugSession(
			"[%s] [CAPACITY] releasing %d bytes: queuedBytes=%d->%d, numWaiters=%d",
			this.streamName,
			bytes,
			this.queuedBytes,
			this.queuedBytes - bytes,
			this.capacityWaiters.length,
		);
		this.queuedBytes -= bytes;

		for (
			let next = this.capacityWaiters.peek();
			next !== undefined && this.hasCapacity(next.input);
			next = this.capacityWaiters.peek()
		) {
			this.capacityWaiters.shift();
			next.resolve(this.enqueue(next.input));
		}
	}

	/** Fail the submits waiting for capacity: the session is closing or failed (#177). */
	private rejectCapacityWaiters(): void {
		if (this.capacityWaiters.length === 0) {
			return;
		}
		const error = appendSessionClosedError(this.fatalError);
		for (const waiter of this.capacityWaiters) {
			waiter.reject(error);
		}
		this.capacityWaiters.clear();
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
			// Should never happen, but a session must fail rather than hang.
			return this.abort(s2Error(e));
		});
	}

	/**
	 * Main pump loop: processes inflight queue, handles acks, retries, and recovery.
	 */
	private async runPump(): Promise<void> {
		debugSession("[%s] pump started", this.streamName);

		while (true) {
			debugSession(
				"[%s] [PUMP] loop: inflight=%d, queuedBytes=%d, closing=%s, pumpStopped=%s",
				this.streamName,
				this.inflight.length,
				this.queuedBytes,
				this.closing,
				this.pumpStopped,
			);

			// Check if we should stop
			if (this.pumpStopped) {
				debugSession("[%s] [PUMP] stopped by flag", this.streamName);
				return;
			}

			// If closing and queue is empty, stop. close() has failed the
			// submits waiting for capacity.
			if (this.closing && this.inflight.length === 0) {
				debugSession(
					"[%s] [PUMP] closing and queue empty, stopping",
					this.streamName,
				);
				this.stopped.abort();
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
			const head = this.inflight.peek()!;
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
			if (this.pumpStopped) {
				debugSession(
					"[%s] [PUMP] stopped after ensureSession",
					this.streamName,
				);
				return;
			}
			if (!this.session) {
				// Session creation failed - check max attempts before retrying
				const effectiveMax = Math.max(1, this.retryConfig.maxAttempts);
				const allowedRetries = effectiveMax - 1;
				if (this.currentAttempt >= allowedRetries) {
					debugSession(
						"[%s] [PUMP] session creation failed, max attempts reached (%d), aborting",
						this.streamName,
						effectiveMax,
					);
					const wrappedError = new S2Error({
						message: `Max attempts (${effectiveMax}) exhausted: connection failed`,
						status: 502,
						code: "connection_failed",
					});
					await this.abort(wrappedError);
					return;
				}

				this.consecutiveFailures++;
				this.currentAttempt++;
				const delay = calculateDelay(
					this.consecutiveFailures - 1,
					this.retryConfig.minBaseDelayMillis,
					this.retryConfig.maxBaseDelayMillis,
				);
				debugSession(
					"[%s] [PUMP] session creation failed, backing off for %dms (retry %d/%d)",
					this.streamName,
					delay,
					this.currentAttempt,
					allowedRetries,
				);
				await sleep(delay, this.stopped.signal);
				continue;
			}

			// Pipelined on s2s
			this.sendQueued();

			// Wait for head with timeout
			debugSession("[%s] [PUMP] waiting for head result", this.streamName);
			const result = await this.waitForHead(head);
			if (this.pumpStopped || result.kind === "stopped") {
				// abort() may have fired (and reset capacity accounting) while we were
				// parked here; don't process the now-stale result.
				debugSession("[%s] [PUMP] stopped after waitForHead", this.streamName);
				return;
			}
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
				head.settle(ok(ack));

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

				// Planned drain handoffs. Both errors guarantee no side effects: an
				// advised session refuses new input without writing it, and a
				// draining server acknowledges everything it accepted before ending
				// the session, so anything still unacknowledged was never
				// registered. If the server's drain window lapses instead, the
				// connection drops without `server_draining` and the ordinary
				// ambiguous-disconnect handling below applies.
				const draining =
					error.code === RECONNECT_ADVISED_CODE || isServerDraining(error);

				// Check policy compliance: under noSideEffects, only retry when
				// we can determine no mutation occurred. This is true if either:
				// 1. The error itself guarantees no side effects (e.g. rate_limited, hot_server)
				// 2. No inflight batch may have reached the server in this attempt
				if (
					this.retryConfig.appendRetryPolicy === "noSideEffects" &&
					!error.hasNoSideEffects() &&
					this.inflight.some((entry) => entry.sent)
				) {
					debugSession(
						"[%s] error not policy-compliant (noSideEffects), aborting",
						this.streamName,
					);
					await this.abort(error);
					return;
				}

				// Under noSideEffects, also check that all inflight entries
				// are idempotent. Non-idempotent entries that were already
				// sent may have been processed, and resubmitting would cause
				// duplicates. A drain handoff is exempt: the server acknowledged
				// every accepted input before ending the session, so the
				// unacknowledged remainder was never processed.
				if (
					!draining &&
					this.retryConfig.appendRetryPolicy === "noSideEffects"
				) {
					const hasNonIdempotentSent = this.inflight.some(
						(entry, index) =>
							index > 0 && entry.sent && entry.input.matchSeqNum === undefined,
					);
					if (hasNonIdempotentSent) {
						debugSession(
							"[%s] non-idempotent pipelined entries already sent, aborting under noSideEffects",
							this.streamName,
						);
						await this.abort(error);
						return;
					}
				}

				// Planned drain handoffs do not consume retry attempts. Repeated
				// handoffs stay bounded because the draining connection has been
				// dropped from the pool and the server refuses new connections once
				// it drains, so a fresh dial either lands elsewhere or fails with an
				// ordinary, budgeted error.
				// Check max attempts (total attempts include initial; retries = max - 1)
				const effectiveMax = Math.max(1, this.retryConfig.maxAttempts);
				const allowedRetries = effectiveMax - 1;
				if (!draining && this.currentAttempt >= allowedRetries) {
					debugSession(
						"[%s] max attempts reached (%d), aborting",
						this.streamName,
						effectiveMax,
					);
					const wrappedError = new S2Error({
						message: `Max attempts (${effectiveMax}) exhausted: ${error.message}`,
						status: error.status,
						code: error.code,
						// Keep the origin so hasNoSideEffects() matches the final error.
						origin: error.origin,
						data: error.data,
					});
					await this.abort(wrappedError);
					return;
				}

				// Perform recovery
				if (draining) {
					debugSession(
						"[%s] reconnecting append session while server drains",
						this.streamName,
					);
				} else {
					this.consecutiveFailures++;
					this.currentAttempt++;

					debugSession(
						"[%s] performing recovery (retry %d/%d)",
						this.streamName,
						this.currentAttempt,
						allowedRetries,
					);
				}

				await this.recover(
					!draining && !error.hasNoSideEffects(),
					draining ? 0 : undefined,
				);
			}
		}
	}

	/**
	 * Wait for head entry's innerPromise with timeout, sending entries
	 * submitted meanwhile as they arrive.
	 *
	 * Per-attempt ack timeout semantics:
	 * - The deadline is computed from the current attempt's start time using a
	 *   monotonic clock (performance.now) to avoid issues with wall clock adjustments.
	 * - Each retry gets a fresh timeout window (attemptStartedMonotonicMs is reset
	 *   when the entry is resent).
	 * - If attempt start is missing (for backward compatibility), we measure
	 *   from "now" with the full timeout window.
	 */
	private waitForHead(head: InflightEntry): Promise<HeadResult> {
		const attemptStart = head.attemptStartedMonotonicMs ?? performance.now();
		const deadline = attemptStart + this.requestTimeoutMillis;
		const remaining = Math.max(0, Math.ceil(deadline - performance.now()));

		return new Promise((resolve) => {
			let done = false;
			const finish = (result: HeadResult) => {
				if (done) return;
				done = true;
				clearTimeout(timer);
				this.pumpWakeup = undefined;
				resolve(result);
			};
			const timer = setTimeout(() => finish({ kind: "timeout" }), remaining);
			void head.innerPromise.then((value) =>
				finish({ kind: "settled", value }),
			);
			// A submit, close() or abort() wakes the pump while it waits.
			this.pumpWakeup = () => {
				if (this.pumpStopped) {
					finish({ kind: "stopped" });
				} else {
					this.sendQueued();
				}
			};
		});
	}

	/**
	 * Recover from a transient error: end the failed attempt and back off. The
	 * pump then opens a new session and resends every inflight entry, in order.
	 *
	 * @param uncertain Whether a batch the failed attempt sent may have taken effect
	 */
	private async recover(
		uncertain: boolean,
		backoffMillis?: number,
	): Promise<void> {
		debugSession("[%s] starting recovery", this.streamName);

		// End the failed attempt, so it sends nothing more, and keep what it may
		// have done in priorUncertainty.
		if (this.session) {
			try {
				const closeResult = await this.session.close({ cancel: true });
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
		this.toSubmit.clear();
		for (const entry of this.inflight) {
			if (entry.sent && uncertain) {
				entry.priorUncertainty = true;
			}
			entry.sent = false;
			this.toSubmit.push(entry);
		}

		// Calculate backoff unless the caller supplied a delay.
		const delay =
			backoffMillis ??
			calculateDelay(
				this.consecutiveFailures - 1,
				this.retryConfig.minBaseDelayMillis,
				this.retryConfig.maxBaseDelayMillis,
			);
		debugSession("[%s] backing off for %dms", this.streamName, delay);
		await sleep(delay, this.stopped.signal);
	}

	/** Send every queued entry on the current session, in order. */
	private sendQueued(): void {
		const session = this.session;
		if (!session) {
			return;
		}
		for (
			let entry = this.toSubmit.shift();
			entry !== undefined;
			entry = this.toSubmit.shift()
		) {
			this.send(session, entry);
		}
	}

	/** Start an attempt to send `entry` on `session`. */
	private send(session: TransportAppendSession, entry: InflightEntry): void {
		debugSession(
			"[%s] sending entry (%d records, %d bytes, match_seq_num=%s)",
			this.streamName,
			entry.expectedCount,
			entry.input.meteredBytes,
			entry.input.matchSeqNum ?? "none",
		);
		entry.attemptStartedMonotonicMs = performance.now();
		// A transport should return errors, but one that throws or rejects must
		// fail this attempt, not the pump or the caller of submit().
		let result: Promise<AppendResult>;
		try {
			result = session.submit(entry.input, () => {
				entry.sent = true;
			});
		} catch (e) {
			result = Promise.reject(e);
		}
		entry.innerPromise = result.catch((e) => err(s2Error(e)));
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
			const session = await this.generator(this.sessionOptions);
			if (this.pumpStopped) {
				// abort() ran meanwhile, so nothing else would close it.
				await session.close({ cancel: true });
				return;
			}
			this.session = session;
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
	private abort(error: S2Error): Promise<void> {
		if (this.abortPromise) {
			return this.abortPromise;
		}
		if (this.pumpStopped || this.closed) {
			return Promise.resolve(); // Already closed or aborted
		}

		debugSession("[%s] aborting session: %s", this.streamName, error.message);
		this.release();

		const anyUncertain = this.inflight.some((entry) => entry.priorUncertainty);
		const sessionError = withPriorUncertainty(error, anyUncertain);
		this.fatalError = sessionError;
		this.stopped.abort();

		// Wake pump if it's sleeping so it can check the pumpStopped flag
		if (this.pumpWakeup) {
			this.pumpWakeup();
		}

		// Resolve all inflight entries with error
		debugSession(
			"[%s] rejecting %d inflight entries",
			this.streamName,
			this.inflight.length,
		);
		// Only appends that may have reached the server get the session's error.
		const unsent = appendSessionClosedError(sessionError);
		for (const entry of this.inflight) {
			entry.settle(
				err(
					entry.sent || entry.priorUncertainty
						? withPriorUncertainty(error, entry.priorUncertainty)
						: unsent,
				),
			);
		}
		this.inflight.clear();
		this.toSubmit.clear();
		this.queuedBytes = 0;

		// Error the readable stream
		try {
			this.acksController?.error(sessionError);
		} catch (e) {
			debugSession(
				"[%s] failed to error acks controller: %s",
				this.streamName,
				e,
			);
		}

		this.rejectCapacityWaiters();

		// Close inner session, without waiting on the server
		const session = this.session;
		this.session = undefined;
		this.abortPromise = (async () => {
			if (session) {
				debugSession("[%s] closing inner session", this.streamName);
				try {
					await session.close({ cancel: true });
				} catch (e) {
					debugSession(
						"[%s] error closing session during abort: %s",
						this.streamName,
						e,
					);
				}
			}
		})();
		return this.abortPromise;
	}

	/**
	 * Close the append session.
	 * Waits for all pending appends to complete before resolving.
	 * Does not interrupt recovery - allows it to complete.
	 */
	close(): Promise<void> {
		if (!this.closePromise) {
			this.closePromise = this.closeInternal();
		}
		return this.closePromise;
	}

	private async closeInternal(): Promise<void> {
		debugSession("[%s] close requested", this.streamName);
		this.closing = true;

		this.rejectCapacityWaiters();

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

		if (this.abortPromise) {
			await this.abortPromise;
		}

		// Close inner session
		const session = this.session;
		this.session = undefined;
		if (session) {
			try {
				const result = await session.close();
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
		this.stopped.abort();
		this.release();

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
