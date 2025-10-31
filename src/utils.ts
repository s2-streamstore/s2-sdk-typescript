import type { AppendRecord as AppendRecordType } from "./stream.js";

type Headers =
	| Record<string, string>
	| Array<[string | Uint8Array, string | Uint8Array]>;

export type AppendRecord = AppendRecordType;

/**
 * Helpers to construct appendable records.
 *
 * These helpers mirror the OpenAPI record schema and add convenience builders for S2 command records:
 * - `make` creates a normal record
 * - `command` creates a command record with an empty-name header set to the command name
 * - `fence` is a command record enforcing a fencing token
 * - `trim` is a command record that encodes a sequence number for trimming
 */
export const AppendRecord = {
	make: (
		body?: string | Uint8Array,
		headers?: Headers,
		timestamp?: AppendRecordType["timestamp"],
	): AppendRecordType => ({
		body,
		headers,
		timestamp,
	}),
	command: (
		/** Command name (e.g. "fence" or "trim"). */
		command: string,
		body?: string | Uint8Array,
		timestamp?: AppendRecordType["timestamp"],
	): AppendRecordType => ({
		body,
		headers: [["", command]],
		timestamp,
	}),
	fence: (
		fencing_token: string,
		timestamp?: AppendRecordType["timestamp"],
	) => {
		return AppendRecord.command(
			"fence",
			fencing_token,
			timestamp,
		);
	},
	trim: (
		seqNum: number | bigint,		
		timestamp?: AppendRecordType["timestamp"],
	): AppendRecordType => {
		// Encode sequence number as 8 big-endian bytes
		const buffer = new Uint8Array(8);
		const view = new DataView(buffer.buffer);
		view.setBigUint64(0, BigInt(seqNum), false); // false = big-endian
		return AppendRecord.command("trim", buffer, timestamp);
	},
} as const;
