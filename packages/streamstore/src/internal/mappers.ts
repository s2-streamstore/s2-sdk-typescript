/**
 * Internal type mappers between SDK types and generated types.
 *
 * Only used for hot-path types (records, append/read responses).
 * Config, info, and metric types are used directly from generated types.
 */

import * as API from "../generated/types.gen.js";
import type * as InternalTypes from "../lib/stream/types.js";
import * as Types from "../types.js";

// =============================================================================
// Utilities
// =============================================================================

const textEncoder = new TextEncoder();

function toBytes(value: string | Uint8Array): Uint8Array {
	return typeof value === "string" ? textEncoder.encode(value) : value;
}

function toBase64(value: string | Uint8Array): string {
	const bytes = toBytes(value);
	if (typeof btoa !== "undefined") {
		return btoa(String.fromCharCode(...bytes));
	}
	return Buffer.from(bytes).toString("base64");
}

function fromBase64(value: string): Uint8Array {
	if (typeof atob !== "undefined") {
		const binary = atob(value);
		const bytes = new Uint8Array(binary.length);
		for (let i = 0; i < binary.length; i++) {
			bytes[i] = binary.charCodeAt(i);
		}
		return bytes;
	}
	return new Uint8Array(Buffer.from(value, "base64"));
}

/** Convert milliseconds to Date. */
function toDate(ms: number): Date {
	return new Date(ms);
}

/** Convert Date or milliseconds to milliseconds. */
function toEpochMs(value: number | Date | undefined | null): number | null {
	if (value === undefined || value === null) return null;
	return typeof value === "number" ? value : value.getTime();
}

// =============================================================================
// Stream Position Mapper
// =============================================================================

/**
 * Convert API StreamPosition to SDK StreamPosition.
 */
export function fromAPIStreamPosition(
	pos: API.StreamPosition,
): Types.StreamPosition {
	return {
		seqNum: pos.seq_num,
		timestamp: toDate(pos.timestamp),
	};
}

/**
 * Convert API AppendAck to SDK AppendAck.
 */
export function fromAPIAppendAck(ack: API.AppendAck): Types.AppendAck {
	return {
		start: fromAPIStreamPosition(ack.start),
		end: fromAPIStreamPosition(ack.end),
		tail: fromAPIStreamPosition(ack.tail),
	};
}

/**
 * Convert API TailResponse to SDK TailResponse.
 */
export function fromAPITailResponse(res: API.TailResponse): Types.TailResponse {
	return {
		tail: fromAPIStreamPosition(res.tail),
	};
}

// =============================================================================
// Record Mappers - Append
// =============================================================================

/**
 * Convert SDK AppendRecord to API AppendRecord (for JSON/REST API).
 */
export function toAPIAppendRecord(
	record: Types.AppendRecord,
): API.AppendRecord {
	const isStringRecord = "body" in record && typeof record.body === "string";

	if (isStringRecord) {
		const stringRecord = record as Types.StringAppendRecord;
		return {
			body: stringRecord.body,
			headers: stringRecord.headers?.map(([name, value]) => [name, value]),
			timestamp: toEpochMs(stringRecord.timestamp),
		};
	} else {
		const bytesRecord = record as Types.BytesAppendRecord;
		return {
			body: toBase64(bytesRecord.body),
			headers: bytesRecord.headers?.map(([name, value]) => [
				toBase64(name),
				toBase64(value),
			]),
			timestamp: toEpochMs(bytesRecord.timestamp),
		};
	}
}

// =============================================================================
// Record Mappers - Read
// =============================================================================

/**
 * Convert API SequencedRecord to SDK ReadRecord (string format).
 */
function fromAPISequencedRecordString(
	record: API.SequencedRecord,
): Types.ReadRecord<"string"> {
	let headers: ReadonlyArray<readonly [string, string]> = [];
	if (record.headers) {
		if (Array.isArray(record.headers)) {
			headers = record.headers.map(([name, value]) => [name, value] as const);
		} else if (typeof record.headers === "object") {
			headers = Object.entries(record.headers as Record<string, string>);
		}
	}

	return {
		seqNum: record.seq_num,
		timestamp: toDate(record.timestamp),
		body: record.body ?? "",
		headers,
	};
}

/**
 * Convert API SequencedRecord to SDK ReadRecord (bytes format).
 */
function fromAPISequencedRecordBytes(
	record: API.SequencedRecord,
): Types.ReadRecord<"bytes"> {
	let body: Uint8Array;
	if (!record.body) {
		body = new Uint8Array();
	} else if (typeof record.body === "string") {
		body = fromBase64(record.body);
	} else {
		body = record.body as Uint8Array;
	}

	let headers: ReadonlyArray<readonly [Uint8Array, Uint8Array]> = [];
	if (record.headers) {
		if (Array.isArray(record.headers)) {
			headers = record.headers.map(([name, value]) => {
				const nameBytes =
					typeof name === "string" ? fromBase64(name) : (name as Uint8Array);
				const valueBytes =
					typeof value === "string" ? fromBase64(value) : (value as Uint8Array);
				return [nameBytes, valueBytes] as const;
			});
		} else if (typeof record.headers === "object") {
			headers = Object.entries(record.headers as Record<string, string>).map(
				([name, value]) => [fromBase64(name), fromBase64(value)] as const,
			);
		}
	}

	return {
		seqNum: record.seq_num,
		timestamp: toDate(record.timestamp),
		body,
		headers,
	};
}

// =============================================================================
// Response Mappers
// =============================================================================

/** Input type for read batch mappers - accepts both API and internal types. */
type ReadBatchInput<Format extends "string" | "bytes"> =
	| API.ReadBatch
	| InternalTypes.ReadBatch<Format>;

/**
 * Convert API/internal ReadBatch to SDK ReadBatch (string format).
 */
export function fromAPIReadBatchString<
	Format extends "string" | "bytes" = "string",
>(batch: ReadBatchInput<Format>): Types.ReadBatch<"string"> {
	return {
		records: batch.records.map((r) =>
			fromAPISequencedRecordString(r as API.SequencedRecord),
		),
		tail: batch.tail ? fromAPIStreamPosition(batch.tail) : undefined,
	};
}

/**
 * Convert API/internal ReadBatch to SDK ReadBatch (bytes format).
 */
export function fromAPIReadBatchBytes<
	Format extends "string" | "bytes" = "bytes",
>(batch: ReadBatchInput<Format>): Types.ReadBatch<"bytes"> {
	return {
		records: batch.records.map((r) =>
			fromAPISequencedRecordBytes(r as API.SequencedRecord),
		),
		tail: batch.tail ? fromAPIStreamPosition(batch.tail) : undefined,
	};
}

// =============================================================================
// Read Input Mapper
// =============================================================================

/**
 * Convert SDK ReadInput (camelCase) to flat query parameters for the API (snake_case).
 */
export function toAPIReadQuery(input?: Types.ReadInput): {
	seq_num?: number;
	timestamp?: number;
	tail_offset?: number;
	clamp?: boolean;
	count?: number;
	bytes?: number;
	until?: number;
	wait?: number;
	ignore_command_records?: boolean;
} {
	if (!input) {
		return {};
	}

	const query: ReturnType<typeof toAPIReadQuery> = {};

	if (input.start?.from) {
		const from = input.start.from;
		if ("seqNum" in from) {
			query.seq_num = from.seqNum;
		} else if ("timestamp" in from) {
			// Convert Date to milliseconds if needed
			query.timestamp =
				typeof from.timestamp === "number"
					? from.timestamp
					: from.timestamp.getTime();
		} else if ("tailOffset" in from) {
			query.tail_offset = from.tailOffset;
		}
	}

	if (input.start?.clamp !== undefined) {
		query.clamp = input.start.clamp;
	}

	if (input.stop?.limits) {
		if (input.stop.limits.count !== undefined) {
			query.count = input.stop.limits.count;
		}
		if (input.stop.limits.bytes !== undefined) {
			query.bytes = input.stop.limits.bytes;
		}
	}

	if (input.stop?.untilTimestamp !== undefined) {
		query.until =
			typeof input.stop.untilTimestamp === "number"
				? input.stop.untilTimestamp
				: input.stop.untilTimestamp.getTime();
	}

	if (input.stop?.waitSecs !== undefined) {
		query.wait = Math.floor(input.stop.waitSecs);
	}

	if (input.ignoreCommandRecords !== undefined) {
		query.ignore_command_records = input.ignoreCommandRecords;
	}

	return query;
}
