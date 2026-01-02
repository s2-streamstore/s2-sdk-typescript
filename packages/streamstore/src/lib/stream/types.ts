import type { RetryConfig, S2RequestOptions } from "../../common.js";
import { S2Error } from "../../error.js";
import type * as API from "../../generated/index.js";
import type * as Types from "../../types.js";
import type * as Redacted from "../redacted.js";
import type * as Result from "../result.js";

export type ReadHeaders<Format extends "string" | "bytes" = "string"> =
	Format extends "string"
		? Record<string, string>
		: Array<[Uint8Array, Uint8Array]>;

/**
 * Internal read batch type used by transports.
 * Records use API-level field names (snake_case).
 */
export type ReadBatch<Format extends "string" | "bytes" = "string"> = {
	records: Array<ReadRecord<Format>>;
	tail?: API.StreamPosition | null;
};

/**
 * Internal read record type used by transports.
 * Uses API-level field names (snake_case).
 */
export type ReadRecord<Format extends "string" | "bytes" = "string"> = {
	seq_num: number;
	timestamp: number;
	body?: Format extends "string" ? string : Uint8Array;
	headers?: ReadHeaders<Format>;
};

export type ReadArgs<Format extends "string" | "bytes" = "string"> =
	API.ReadData["query"] & {
		as?: Format;
	};

export type AppendHeaders<Format extends "string" | "bytes" = "string"> =
	Format extends "string"
		? Array<[string, string]>
		: Array<[Uint8Array, Uint8Array]>;

export type AppendRecordForFormat<
	Format extends "string" | "bytes" = "string",
> = Format extends "string"
	? Types.StringAppendRecord
	: Types.BytesAppendRecord;

// Use SDK AppendRecord type for internal operations
export type AppendRecord = Types.AppendRecord;

/**
 * Stream of append acknowledgements used by {@link AppendSession}.
 */
export interface AcksStream
	extends ReadableStream<Types.AppendAck>,
		AsyncIterable<Types.AppendAck> {}

/**
 * Low-level append session implemented by transports.
 *
 * - Never throws: errors are encoded in the returned {@link AppendResult}.
 * - Does not implement retry or backpressure; those are added by {@link AppendSession}.
 */
export interface TransportAppendSession {
	submit(input: Types.AppendInput): Promise<Result.AppendResult>;
	close(): Promise<Result.CloseResult>;
}

export class BatchSubmitTicket {
	constructor(
		private readonly promise: Promise<Types.AppendAck>,
		public readonly bytes: number,
		public readonly numRecords: number,
	) {}

	/**
	 * Returns a promise that resolves with the AppendAck once the batch is durable.
	 */
	ack(): Promise<Types.AppendAck> {
		return this.promise;
	}
}

/**
 * Public AppendSession interface with retry, backpressure, and readable/writable streams.
 *
 * Typical lifecycle:
 * 1. Call {@link S2Stream.appendSession} to create a session (optionally tuning {@link AppendSessionOptions}).
 * 2. Submit batches with {@link AppendSession.submit} or pipe `AppendInput` objects into {@link AppendSession.writable}.
 * 3. Observe acknowledgements via {@link AppendSession.readable} / {@link AppendSession.acks}.
 * 4. Call {@link AppendSession.close} to flush and surface any fatal errors.
 *
 * @example
 * ```ts
 * const session = await stream.appendSession();
 * const ackTicket = await session.submit(
 *   AppendInput.create([AppendRecord.string({ body: "event" })]),
 * );
 * await ackTicket.ack();
 * await session.close();
 * ```
 */
export interface AppendSession extends AsyncDisposable {
	/**
	 * Readable stream of acknowledgements for appends.
	 */
	readonly readable: ReadableStream<Types.AppendAck>;
	/**
	 * Writable stream of append requests.
	 */
	readonly writable: WritableStream<Types.AppendInput>;
	/**
	 * Submit an append request.
	 * Returns a promise that resolves to a submit ticket once the batch is enqueued (has capacity).
	 * Call ticket.ack() to get a promise for the AppendAck once the batch is durable.
	 * This method applies backpressure and will block if capacity limits are reached.
	 */
	submit(input: Types.AppendInput): Promise<BatchSubmitTicket>;
	/**
	 * Close the append session, waiting for all inflight appends to settle.
	 */
	close(): Promise<void>;
	/**
	 * Get a stream of acknowledgements for appends.
	 */
	acks(): AcksStream;
	/**
	 * Get the last acknowledged position, if any.
	 */
	lastAckedPosition(): Types.AppendAck | undefined;
	/**
	 * If the session failed, returns the fatal error that caused it to stop.
	 */
	failureCause(): S2Error | undefined;
}

/**
 * Result type for transport-level read operations.
 * Transport sessions yield ReadResult instead of throwing errors.
 */
export type ReadResult<Format extends "string" | "bytes" = "string"> =
	| { ok: true; value: ReadRecord<Format> }
	| { ok: false; error: S2Error };

/**
 * Transport-level read session interface.
 * Transport implementations yield ReadResult and never throw errors from the stream.
 * ReadSession wraps these and converts them to the public ReadSession interface.
 */
export interface TransportReadSession<
	Format extends "string" | "bytes" = "string",
> extends ReadableStream<ReadResult<Format>>,
		AsyncIterable<ReadResult<Format>>,
		AsyncDisposable {
	nextReadPosition(): API.StreamPosition | undefined;
	lastObservedTail(): API.StreamPosition | undefined;
}

/**
 * Public-facing read session interface.
 *
 * Yields records directly (as an async iterable or `ReadableStream`) and translates transport errors into thrown exceptions.
 * Track progress using {@link ReadSession.nextReadPosition} / {@link ReadSession.lastObservedTail}.
 *
 * @example
 * ```ts
 * const session = await stream.readSession({
 *   start: { from: { tailOffset: 50 } },
 *   stop: { wait: 15 },
 * });
 *
 * for await (const record of session) {
 *   console.log(record.seqNum, record.body);
 * }
 * ```
 */
export interface ReadSession<Format extends "string" | "bytes" = "string">
	extends ReadableStream<Types.ReadRecord<Format>>,
		AsyncIterable<Types.ReadRecord<Format>>,
		AsyncDisposable {
	/**
	 * Get the next read position, if known.
	 */
	nextReadPosition(): Types.StreamPosition | undefined;
	/**
	 * Get the last observed tail position, if known.
	 */
	lastObservedTail(): Types.StreamPosition | undefined;
}

/**
 * Options that control client-side append backpressure and concurrency.
 *
 * These are applied by {@link AppendSession}; transports ignore them.
 */
export interface AppendSessionOptions {
	/**
	 * Aggregate size of records, as calculated by {@link meteredBytes}, to allow in-flight before applying backpressure (default: 10 MiB).
	 */
	maxInflightBytes?: number;
	/**
	 * Maximum number of batches allowed in-flight before
	 * applying backpressure.
	 */
	maxInflightBatches?: number;
}

export interface SessionTransport {
	makeAppendSession(
		stream: string,
		args?: AppendSessionOptions,
		options?: S2RequestOptions,
	): Promise<AppendSession>;
	makeReadSession<Format extends "string" | "bytes" = "string">(
		stream: string,
		args?: ReadArgs<Format>,
		options?: S2RequestOptions,
	): Promise<ReadSession<Format>>;
	close(): Promise<void>;
}

export type SessionTransports = "fetch" | "s2s";

export interface TransportConfig {
	baseUrl: string;
	accessToken: Redacted.Redacted;
	forceTransport?: SessionTransports;
	/**
	 * Basin name to include in s2-basin header when using account endpoint
	 */
	basinName?: string;
	/**
	 * Retry configuration inherited from the top-level client
	 */
	retry?: RetryConfig;
}
