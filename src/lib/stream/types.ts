import type { RetryConfig, S2RequestOptions } from "../../common.js";
import type { S2Error } from "../../error.js";
import type {
	AppendAck,
	AppendInput as GeneratedAppendInput,
	AppendRecord as GeneratedAppendRecord,
	ReadBatch as GeneratedReadBatch,
	SequencedRecord as GeneratedSequencedRecord,
	ReadData,
	StreamPosition,
} from "../../generated/index.js";
import type * as Redacted from "../redacted.js";

export type ReadHeaders<Format extends "string" | "bytes" = "string"> =
	Format extends "string"
		? Record<string, string>
		: Array<[Uint8Array, Uint8Array]>;

export type ReadBatch<Format extends "string" | "bytes" = "string"> = Omit<
	GeneratedReadBatch,
	"records"
> & {
	records?: Array<ReadRecord<Format>>;
};

export type ReadRecord<Format extends "string" | "bytes" = "string"> = Omit<
	GeneratedSequencedRecord,
	"body" | "headers"
> & {
	body?: Format extends "string" ? string : Uint8Array;
	headers?: ReadHeaders<Format>;
};

export type ReadArgs<Format extends "string" | "bytes" = "string"> =
	ReadData["query"] & {
		as?: Format;
	};

export type AppendHeaders<Format extends "string" | "bytes" = "string"> =
	Format extends "string"
		? Array<[string, string]> | Record<string, string>
		: Array<[Uint8Array, Uint8Array]>;

export type AppendRecordForFormat<
	Format extends "string" | "bytes" = "string",
> = Omit<GeneratedAppendRecord, "body" | "headers"> & {
	body?: Format extends "string" ? string : Uint8Array;
	headers?: AppendHeaders<Format>;
};

export type AppendRecord =
	| AppendRecordForFormat<"string">
	| AppendRecordForFormat<"bytes">;

export type StringAppendRecord = AppendRecordForFormat<"string">;
export type BytesAppendRecord = AppendRecordForFormat<"bytes">;

export type AppendArgs = Omit<GeneratedAppendInput, "records"> & {
	records: Array<AppendRecord>;
};

/**
 * Stream of append acknowledgements used by {@link AppendSession}.
 */
export interface AcksStream
	extends ReadableStream<AppendAck>,
		AsyncIterable<AppendAck> {}

/**
 * Low-level append session implemented by transports.
 *
 * - Never throws: errors are encoded in the returned {@link AppendResult}.
 * - Does not implement retry or backpressure; those are added by {@link AppendSession}.
 */
export interface TransportAppendSession {
	submit(
		records: AppendRecord | AppendRecord[],
		args?: Omit<AppendArgs, "records"> & { precalculatedSize?: number },
	): Promise<import("../result.js").AppendResult>;
	close(): Promise<import("../result.js").CloseResult>;
}

/**
 * Public AppendSession interface with retry, backpressure, and streams.
 * This is what users interact with - implemented by AppendSession in ../retry.ts.
 */
export interface AppendSession extends AsyncDisposable {
	/**
	 * Readable stream of acknowledgements for appends.
	 */
	readonly readable: ReadableStream<AppendAck>;
	/**
	 * Writable stream of append requests.
	 */
	readonly writable: WritableStream<AppendArgs>;
	/**
	 * Submit an append request and await its acknowledgement.
	 * This method does not apply backpressure; use {@link writable} for that.
	 */
	submit(
		records: AppendRecord | AppendRecord[],
		args?: Omit<AppendArgs, "records"> & { precalculatedSize?: number },
	): Promise<AppendAck>;
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
	lastAckedPosition(): AppendAck | undefined;
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
	nextReadPosition(): StreamPosition | undefined;
	lastObservedTail(): StreamPosition | undefined;
}

/**
 * Public-facing read session interface.
 * Yields records directly and propagates errors by throwing (standard stream behavior).
 */
export interface ReadSession<Format extends "string" | "bytes" = "string">
	extends ReadableStream<ReadRecord<Format>>,
		AsyncIterable<ReadRecord<Format>>,
		AsyncDisposable {
	nextReadPosition(): StreamPosition | undefined;
	lastObservedTail(): StreamPosition | undefined;
}

/**
 * Options that control client-side append backpressure and concurrency.
 *
 * These are applied by {@link AppendSession}; transports ignore them.
 */
export interface AppendSessionOptions {
	/**
	 * Maximum bytes to queue before applying backpressure (default: 10 MiB).
	 * Enforced by AppendSession; underlying transports do not apply
	 * byte-based backpressure on their own.
	 */
	maxInflightBytes?: number;
	/**
	 * Maximum number of batches allowed in-flight (including queued) before
	 * applying backpressure. This is enforced by AppendSession; underlying
	 * transport sessions do not implement their own backpressure.
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
