import type {
	AppendAck,
	AppendInput as GeneratedAppendInput,
	AppendRecord as GeneratedAppendRecord,
	ReadBatch as GeneratedReadBatch,
	SequencedRecord as GeneratedSequencedRecord,
	ReadData,
	StreamPosition,
} from "../../generated/index.js";
import type { S2RequestOptions } from "../common.js";
import type * as Redacted from "../redacted.js";

export interface BatcherArgs {
	/** Duration in milliseconds to wait before flushing a batch (default: 5ms) */
	lingerDuration?: number;
	/** Maximum number of records in a batch (default: 1000) */
	maxBatchSize?: number;
	/** Optional fencing token to enforce (remains static across batches) */
	fencing_token?: string;
	/** Optional sequence number to match for first batch (auto-increments for subsequent batches) */
	match_seq_num?: number;
}

export type Header<Format extends "string" | "bytes" = "string"> =
	Format extends "string" ? [string, string] : [Uint8Array, Uint8Array];

export type ReadBatch<Format extends "string" | "bytes" = "string"> = Omit<
	GeneratedReadBatch,
	"records"
> & {
	records?: Array<SequencedRecord<Format>>;
};

export type SequencedRecord<Format extends "string" | "bytes" = "string"> =
	Omit<GeneratedSequencedRecord, "body" | "headers"> & {
		body?: Format extends "string" ? string : Uint8Array;
		headers?: Array<Header<Format>>;
	};

export type ReadArgs<Format extends "string" | "bytes" = "string"> =
	ReadData["query"] & {
		as?: Format;
	};

export type AppendRecord = Omit<GeneratedAppendRecord, "body" | "headers"> & {
	body?: string | Uint8Array;
	headers?:
		| Array<[string | Uint8Array, string | Uint8Array]>
		| Record<string, string | Uint8Array>;
};

export type AppendArgs = Omit<GeneratedAppendInput, "records"> & {
	records: Array<AppendRecord>;
};

export interface AcksStream
	extends ReadableStream<AppendAck>,
		AsyncIterable<AppendAck>,
		AsyncDisposable {}

export interface Batcher
	extends WritableStream<AppendRecord | AppendRecord[]>,
		AsyncDisposable {
	submit(records: AppendRecord | AppendRecord[]): Promise<AppendAck>;
	flush(): void;
}

export interface AppendSession
	extends WritableStream<AppendArgs>,
		AsyncDisposable {
	submit(
		records: AppendRecord | AppendRecord[],
		args?: Omit<AppendArgs, "records">,
	): Promise<AppendAck>;
	makeBatcher(args?: BatcherArgs): Batcher;
	acks(): AcksStream;
	close(): Promise<void>;
	lastAckedPosition(): AppendAck | undefined;
}

export interface ReadSession<Format extends "string" | "bytes" = "string">
	extends ReadableStream<SequencedRecord<Format>>,
		AsyncIterable<SequencedRecord<Format>>,
		AsyncDisposable {
	lastReadPosition(): StreamPosition | undefined;
}

export interface SessionTransport {
	makeAppendSession(stream: string): Promise<AppendSession>;
	makeReadSession<Format extends "string" | "bytes" = "string">(
		stream: string,
		args?: ReadArgs<Format>,
		options?: S2RequestOptions,
	): Promise<ReadSession<Format>>;
}

export interface TransportConfig {
	baseUrl: string;
	accessToken: Redacted.Redacted;
}
