/**
 * S2 SDK Types - Selective SDK types for hot paths.
 *
 * For configs, info types, and metrics, use the generated types directly
 * from "./generated/types.gen.js".
 */

import { S2Error } from "./error.js";
import { meteredBytes as calculateMeteredBytes } from "./utils.js";

// =============================================================================
// Stream Position
// =============================================================================

/**
 * Position of a record in a stream.
 */
export interface StreamPosition {
	/** Sequence number assigned by the service. */
	readonly seq_num: number;
	/** Timestamp in milliseconds since Unix epoch. */
	readonly timestamp: number;
}

// =============================================================================
// Append Record Types
// =============================================================================

/**
 * Append record with string body and string headers.
 * Use `AppendRecord.string()` to construct instances.
 */
export interface StringAppendRecord {
	readonly body: string;
	readonly headers?: ReadonlyArray<readonly [string, string]>;
	readonly timestamp?: number;
	/** Pre-calculated metered size in bytes. */
	readonly meteredBytes: number;
}

/**
 * Append record with binary body and binary headers.
 * Use `AppendRecord.bytes()` to construct instances.
 */
export interface BytesAppendRecord {
	readonly body: Uint8Array;
	readonly headers?: ReadonlyArray<readonly [Uint8Array, Uint8Array]>;
	readonly timestamp?: number;
	/** Pre-calculated metered size in bytes. */
	readonly meteredBytes: number;
}

/**
 * Record to be appended to a stream.
 * Can be either string format (text) or bytes format (binary).
 */
export type AppendRecord = StringAppendRecord | BytesAppendRecord;

const textEncoder = new TextEncoder();

/**
 * Factory functions for creating AppendRecord instances.
 */
export namespace AppendRecord {
	/**
	 * Create a string-format append record with pre-calculated metered size.
	 */
	export function string(params: {
		readonly body: string;
		readonly headers?: ReadonlyArray<readonly [string, string]>;
		readonly timestamp?: number;
	}): StringAppendRecord {
		const record: StringAppendRecord = {
			body: params.body,
			headers: params.headers,
			timestamp: params.timestamp,
			meteredBytes: 0,
		};
		(record as any).meteredBytes = calculateMeteredBytes(record as any);
		return record;
	}

	/**
	 * Create a bytes-format append record with pre-calculated metered size.
	 */
	export function bytes(params: {
		readonly body: Uint8Array;
		readonly headers?: ReadonlyArray<readonly [Uint8Array, Uint8Array]>;
		readonly timestamp?: number;
	}): BytesAppendRecord {
		const record: BytesAppendRecord = {
			body: params.body,
			headers: params.headers,
			timestamp: params.timestamp,
			meteredBytes: 0,
		};
		(record as any).meteredBytes = calculateMeteredBytes(record as any);
		return record;
	}

	/**
	 * Create a fence command record.
	 */
	export function fence(
		fencingToken: string,
		timestamp?: number,
	): StringAppendRecord {
		return string({
			body: fencingToken,
			headers: [["", "fence"]],
			timestamp,
		});
	}

	/**
	 * Create a trim command record.
	 */
	export function trim(seqNum: number, timestamp?: number): BytesAppendRecord {
		const buffer = new Uint8Array(8);
		const view = new DataView(buffer.buffer);
		view.setBigUint64(0, BigInt(seqNum), false);

		return bytes({
			body: buffer,
			headers: [[textEncoder.encode(""), textEncoder.encode("trim")]],
			timestamp,
		});
	}
}

// =============================================================================
// Read Record Types
// =============================================================================

/**
 * Record read from a stream.
 * The Format type parameter controls whether body and headers are decoded as strings or kept as binary.
 */
export interface ReadRecord<Format extends "string" | "bytes" = "string"> {
	readonly seq_num: number;
	readonly body: Format extends "string" ? string : Uint8Array;
	readonly headers: Format extends "string"
		? ReadonlyArray<readonly [string, string]>
		: ReadonlyArray<readonly [Uint8Array, Uint8Array]>;
	readonly timestamp: number;
}

// =============================================================================
// Append Input
// =============================================================================

/** Maximum number of records in a single append batch. */
export const MAX_APPEND_RECORDS = 1000;

/** Maximum total metered bytes for records in a single append batch (1 MiB). */
export const MAX_APPEND_BYTES = 1024 * 1024;

/**
 * Input for append operations.
 * Use `AppendInput.create()` to construct with validation.
 */
export interface AppendInput {
	readonly records: ReadonlyArray<AppendRecord>;
	readonly match_seq_num?: number;
	readonly fencing_token?: string;
	/** Pre-calculated total metered size in bytes. */
	readonly meteredBytes: number;
}

/**
 * Factory functions for creating AppendInput instances.
 */
export namespace AppendInput {
	/**
	 * Create an AppendInput with validation.
	 *
	 * @throws {S2Error} If validation fails (empty, too many records, or too large)
	 */
	export function create(
		records: ReadonlyArray<AppendRecord>,
		options?: {
			readonly matchSeqNum?: number;
			readonly fencingToken?: string;
		},
	): AppendInput {
		if (records.length === 0) {
			throw new S2Error({
				message: "AppendInput must contain at least one record",
				origin: "sdk",
			});
		}

		if (records.length > MAX_APPEND_RECORDS) {
			throw new S2Error({
				message: `AppendInput cannot contain more than ${MAX_APPEND_RECORDS} records (got ${records.length})`,
				origin: "sdk",
			});
		}

		const totalBytes = records.reduce((sum, r) => sum + r.meteredBytes, 0);
		if (totalBytes > MAX_APPEND_BYTES) {
			throw new S2Error({
				message: `AppendInput exceeds maximum of ${MAX_APPEND_BYTES} bytes (got ${totalBytes} bytes)`,
				origin: "sdk",
			});
		}

		return {
			records,
			match_seq_num: options?.matchSeqNum,
			fencing_token: options?.fencingToken,
			meteredBytes: totalBytes,
		};
	}
}

// =============================================================================
// Read Input
// =============================================================================

/**
 * Starting position for reading from a stream.
 */
export type ReadFrom =
	| { readonly seq_num: number }
	| { readonly timestamp: number }
	| { readonly tail_offset: number };

/**
 * Where to start reading.
 */
export interface ReadStart {
	readonly from?: ReadFrom;
	/** Start from tail if requested position is beyond it. */
	readonly clamp?: boolean;
}

/**
 * Limits on how much to read.
 */
export interface ReadLimits {
	readonly count?: number;
	readonly bytes?: number;
}

/**
 * When to stop reading.
 */
export interface ReadStop {
	readonly limits?: ReadLimits;
	/** Timestamp at which to stop (exclusive, milliseconds since epoch). */
	readonly until?: number;
	/** Duration in seconds to wait for new records before stopping. */
	readonly wait?: number;
}

/**
 * Input for read operations.
 */
export interface ReadInput {
	readonly start?: ReadStart;
	readonly stop?: ReadStop;
	readonly ignore_command_records?: boolean;
}

// =============================================================================
// Response Types
// =============================================================================

/**
 * Success response to an append request.
 */
export interface AppendAck {
	readonly start: StreamPosition;
	readonly end: StreamPosition;
	readonly tail: StreamPosition;
}

/**
 * Batch of records read from a stream.
 */
export interface ReadBatch<Format extends "string" | "bytes" = "string"> {
	readonly records: ReadonlyArray<ReadRecord<Format>>;
	readonly tail?: StreamPosition;
}

/**
 * Response from checking the tail of a stream.
 */
export interface TailResponse {
	readonly tail: StreamPosition;
}

// =============================================================================
// Session Options
// =============================================================================

/**
 * Options for append sessions (backpressure control).
 */
export interface AppendSessionOptions {
	/** Max in-flight bytes before backpressure (default: 10 MiB). */
	readonly maxInflightBytes?: number;
	/** Max in-flight batches before backpressure. */
	readonly maxInflightBatches?: number;
}
