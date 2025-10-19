import type { AppendRecord as AppendRecordType } from "./stream";

type Headers =
	| Record<string, string>
	| Array<[string | Uint8Array, string | Uint8Array]>;

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
	): AppendRecordType => {
		return {
			body,
			headers,
			timestamp,
		};
	},
	command: (
		/** Command name (e.g. "fence" or "trim"). */
		command: string,
		body?: string | Uint8Array,
		additionalHeaders?: Headers,
		timestamp?: AppendRecordType["timestamp"],
	): AppendRecordType => {
		const headers: AppendRecordType["headers"] = (() => {
			if (!additionalHeaders) {
				return [["", command]];
			} else if (Array.isArray(additionalHeaders)) {
				return [["", command] as [string, string], ...additionalHeaders];
			} else {
				return [
					["", command] as [string, string],
					...Object.entries(additionalHeaders).map(
						([key, value]) => [key, value] as [string, string],
					),
				];
			}
		})();
		return {
			body,
			headers,
			timestamp,
		};
	},
	fence: (
		fencing_token: string,
		additionalHeaders?: Headers,
		timestamp?: AppendRecordType["timestamp"],
	) => {
		return AppendRecord.command(
			"fence",
			fencing_token,
			additionalHeaders,
			timestamp,
		);
	},
	trim: (
		seqNum: number | bigint,
		additionalHeaders?: Headers,
		timestamp?: AppendRecordType["timestamp"],
	): AppendRecordType => {
		// Encode sequence number as 8 big-endian bytes
		const buffer = new Uint8Array(8);
		const view = new DataView(buffer.buffer);
		view.setBigUint64(0, BigInt(seqNum), false); // false = big-endian
		return AppendRecord.command("trim", buffer, additionalHeaders, timestamp);
	},
} as const;
