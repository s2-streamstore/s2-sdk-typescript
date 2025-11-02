import type { S2RequestOptions } from "../../common.js";
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

export interface AcksStream
	extends ReadableStream<AppendAck>,
		AsyncIterable<AppendAck> {}

export interface AppendSession
	extends ReadableWritablePair<AppendAck, AppendArgs>,
		AsyncDisposable {
	submit(
		records: AppendRecord | AppendRecord[],
		args?: Omit<AppendArgs, "records"> & { precalculatedSize?: number },
	): Promise<AppendAck>;
	acks(): AcksStream;
	close(): Promise<void>;
	lastAckedPosition(): AppendAck | undefined;
}

export interface ReadSession<Format extends "string" | "bytes" = "string">
	extends ReadableStream<ReadRecord<Format>>,
		AsyncIterable<ReadRecord<Format>>,
		AsyncDisposable {
	nextReadPosition(): StreamPosition | undefined;
	lastKnownTail(): StreamPosition | undefined;
}

export interface AppendSessionOptions {
	/** Maximum bytes to queue before applying backpressure (default: 10 MiB) */
	maxQueuedBytes?: number;
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
}
