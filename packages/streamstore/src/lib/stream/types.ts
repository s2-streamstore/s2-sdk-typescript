import type { RetryConfig, S2RequestOptions } from "../../common.js";
import { S2Error } from "../../error.js";
import type * as API from "../../generated/index.js";
import type * as Types from "../../types.js";
import type * as Redacted from "../redacted.js";
import type * as Result from "../result.js";
import type { CompressionType } from "./transport/s2s/framing.js";

export type ReadHeaders<Format extends "string" | "bytes" = "string"> =
	Format extends "string"
		? Array<[string, string]>
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
		ignore_command_records?: boolean;
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
	/**
	 * Returns true if data may have been sent to the server since the last
	 * time the session was dormant (zero pending acks).
	 *
	 * Used by the retry layer under the `noSideEffects` policy: when false,
	 * it is safe to retry even errors that could otherwise indicate a
	 * mutation, because no bytes left the client.
	 */
	effectSignalled(): boolean;
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

/** Result from a transport read session. */
export type TransportReadEvent<Format extends "string" | "bytes" = "string"> =
	| { ok: true; batch: ReadBatch<Format> }
	| { ok: false; error: S2Error };

/**
 * Transport-level read session interface.
 * Transport implementations yield batches and never throw errors from the stream.
 * ReadSession wraps these and converts them to the public ReadSession interface.
 */
export interface TransportReadSession<
	Format extends "string" | "bytes" = "string",
> extends ReadableStream<TransportReadEvent<Format>>,
		AsyncIterable<TransportReadEvent<Format>>,
		AsyncDisposable {
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
	 * Returns the latest tail reported for this session. This does not mean the
	 * session has read through that tail.
	 */
	lastObservedTail(): Types.StreamPosition | undefined;
	/**
	 * Reports whether the session has read through its latest reported tail.
	 * Returns false while records remain before the reported tail, after a batch
	 * without a tail, or after a reconnect.
	 * Ignored command records count toward progress.
	 * Use {@link S2Stream.checkTail} for the current stream tail.
	 */
	isCaughtUp(): boolean;
	/**
	 * Returns a promise for the next caught-up state.
	 * Resolves immediately if the session is already caught up.
	 * Remains pending across reconnects.
	 * Call again after the session falls behind.
	 * Continue reading records while the promise is pending.
	 *
	 * Resolves with the tail captured for that state.
	 * Rejects with the read error or `SESSION_CLOSED` if the session ends first.
	 */
	caughtUp(): Promise<Types.StreamPosition>;
}

/**
 * Options that control client-side append backpressure and concurrency.
 *
 * These are applied by {@link AppendSession}; transports ignore them.
 */
export interface AppendSessionOptions {
	/**
	 * Aggregate size of records, as calculated by {@link meteredBytes}, to allow in-flight before applying backpressure (default: 3 MiB).
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

/**
 * HTTP/2 flow-control settings for the s2s transport.
 *
 * Only applies where sessions run over `s2s` (HTTP/2); the fetch transport
 * ignores these. Connections are pooled per endpoint, and clients configured
 * with different settings do not share connections.
 */
export interface Http2Settings {
	/**
	 * Flow-control receive window for each HTTP/2 stream, in bytes.
	 *
	 * Bounds how much data the server can have in flight on a single read
	 * session before the client acknowledges it. Raise this to keep
	 * high-throughput reads saturated over high-latency links; S2 read
	 * batches can be up to 1 MiB each.
	 *
	 * Must be an integer between 65,535 and 2^31 - 1.
	 * @default 10_485_760 (10 MiB)
	 */
	initialStreamWindowSize?: number;
	/**
	 * Flow-control receive window for each HTTP/2 connection, in bytes.
	 *
	 * Bounds in-flight data summed across all sessions multiplexed on one
	 * connection (up to 100 streams per connection).
	 *
	 * Must be an integer between 65,535 and 2^31 - 1.
	 * @default 10_485_760 (10 MiB)
	 */
	connectionWindowSize?: number;
}

export interface TransportConfig {
	baseUrl: string;
	accessToken: Redacted.Redacted;
	/**
	 * Optional base64-encoded client-supplied encryption key for data-plane requests.
	 */
	encryptionKey?: Redacted.Redacted<string>;
	forceTransport?: SessionTransports;
	/**
	 * Basin name to include in s2-basin header when using account endpoint
	 */
	basinName?: string;
	/**
	 * Maximum time in milliseconds to wait for an append ack before timing out.
	 */
	requestTimeoutMillis?: number;
	/**
	 * Maximum time in milliseconds to wait for connection establishment.
	 */
	connectionTimeoutMillis?: number;
	/**
	 * Retry configuration inherited from the top-level client
	 */
	retry?: RetryConfig;
	/**
	 * Compression algorithm applied to s2s frame bodies and advertised via
	 * `Accept-Encoding`. Defaults to `"none"`.
	 */
	compression?: CompressionType;
	/**
	 * HTTP/2 flow-control settings for the s2s transport.
	 */
	http2?: Http2Settings;
}
