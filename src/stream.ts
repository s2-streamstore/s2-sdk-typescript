import {
	FencingTokenMismatchError,
	RangeNotSatisfiableError,
	S2Error,
	SeqNumMismatchError,
} from "./error.js";
import type { Client } from "./generated/client/types.gen.js";
import {
	type AppendAck,
	append,
	checkTail,
	type AppendInput as GeneratedAppendInput,
	type AppendRecord as GeneratedAppendRecord,
	type ReadBatch as GeneratedReadBatch,
	type SequencedRecord as GeneratedSequencedRecord,
	type ReadData,
	read,
	type StreamPosition,
} from "./generated/index.js";
import { decodeFromBase64, encodeToBase64 } from "./lib/base64.js";
import type { S2RequestOptions } from "./lib/common.js";

export class S2Stream {
	private readonly client: Client;

	public readonly name: string;

	constructor(name: string, client: Client) {
		this.name = name;
		this.client = client;
	}

	/**
	 * Check the tail of the stream.
	 *
	 * Returns the next sequence number and timestamp to be assigned (`tail`).
	 */
	public async checkTail(options?: S2RequestOptions) {
		const response = await checkTail({
			client: this.client,
			path: {
				stream: this.name,
			},
			...options,
		});

		if (response.error) {
			throw new S2Error({
				message: response.error.message,
				code: response.error.code ?? undefined,
				status: response.response.status,
			});
		}

		return response.data;
	}

	/**
	 * Read records from the stream.
	 *
	 * - When `as: "bytes"` is provided, bodies and headers are decoded from base64 to `Uint8Array`.
	 * - Supports starting position by `seq_num`, `timestamp`, or `tail_offset` and can clamp to the tail.
	 * - Non-streaming reads are bounded by `count` and `bytes` (defaults 1000 and 1 MiB).
	 * - Use `readSession` for streaming reads
	 */
	public async read<Format extends "string" | "bytes" = "string">(
		args?: ReadArgs<Format>,
		options?: S2RequestOptions,
	): Promise<ReadBatch<Format>> {
		const { as, ...queryParams } = args ?? {};
		const response = await read({
			client: this.client,
			path: {
				stream: this.name,
			},
			headers: {
				...(as === "bytes" ? { "s2-format": "base64" } : {}),
			},
			query: queryParams,
			...options,
		});
		if (response.error) {
			if ("message" in response.error) {
				throw new S2Error({
					message: response.error.message,
					code: response.error.code ?? undefined,
					status: response.response.status,
				});
			} else {
				// special case for 416 - Range Not Satisfiable
				throw new RangeNotSatisfiableError({
					status: response.response.status,
				});
			}
		}

		if (args?.as === "bytes") {
			const res: ReadBatch<"bytes"> = {
				...response.data,
				records: response.data.records?.map(
					(record: GeneratedSequencedRecord) => ({
						...record,
						body: record.body ? decodeFromBase64(record.body) : undefined,
						headers: record.headers?.map(
							(header: [string, string]) =>
								header.map((h: string) => decodeFromBase64(h)) as [
									Uint8Array,
									Uint8Array,
								],
						),
					}),
				),
			};
			return res as ReadBatch<Format>;
		} else {
			const res: ReadBatch<"string"> = response.data;
			return res as ReadBatch<Format>;
		}
	}
	/**
	 * Append one or more records to the stream.
	 *
	 * - Automatically base64-encodes when any body or header is a `Uint8Array`.
	 * - Supports conditional appends via `fencing_token` and `match_seq_num`.
	 * - Returns the acknowledged range and the stream tail after the append.
	 */
	public async append(
		records: AppendRecord | AppendRecord[],
		args?: Omit<AppendArgs, "records">,
		options?: S2RequestOptions,
	): Promise<AppendAck> {
		const recordsArray = Array.isArray(records) ? records : [records];
		const normalizeHeaders = (
			headers: AppendRecord["headers"],
		): [string | Uint8Array, string | Uint8Array][] | undefined => {
			if (headers === undefined) {
				return undefined;
			} else if (Array.isArray(headers)) {
				return headers;
			} else {
				return Object.entries(headers).map(([key, value]) => [key, value]);
			}
		};

		const recordsWithNormalizedHeaders = recordsArray.map((record) => ({
			...record,
			headers: normalizeHeaders(record.headers),
		}));

		const hasBytes =
			recordsWithNormalizedHeaders.some(
				(record) => record.body instanceof Uint8Array,
			) ||
			recordsWithNormalizedHeaders.some((record) =>
				record.headers?.some(
					(header) =>
						header[0] instanceof Uint8Array || header[1] instanceof Uint8Array,
				),
			);

		const encodedRecords = recordsWithNormalizedHeaders.map((record) => ({
			...record,
			body:
				record.body instanceof Uint8Array
					? encodeToBase64(record.body)
					: hasBytes && record.body
						? encodeToBase64(new TextEncoder().encode(record.body))
						: record.body,
			headers: record.headers?.map(
				(header) =>
					header.map((h) =>
						h instanceof Uint8Array
							? encodeToBase64(h)
							: hasBytes
								? encodeToBase64(new TextEncoder().encode(h))
								: h,
					) as [string, string],
			),
		}));

		const response = await append({
			client: this.client,
			path: {
				stream: this.name,
			},
			body: {
				...args,
				records: encodedRecords,
			},
			headers: {
				...(hasBytes ? { "s2-format": "base64" } : {}),
			},
			...options,
		});
		if (response.error) {
			if ("message" in response.error) {
				throw new S2Error({
					message: response.error.message,
					code: response.error.code ?? undefined,
					status: response.response.status,
				});
			} else {
				// special case for 412 - append condition failed
				if ("seq_num_mismatch" in response.error) {
					throw new SeqNumMismatchError({
						message: "Append condition failed: sequence number mismatch",
						code: "APPEND_CONDITION_FAILED",
						status: response.response.status,
						expectedSeqNum: response.error.seq_num_mismatch,
					});
				} else if ("fencing_token_mismatch" in response.error) {
					throw new FencingTokenMismatchError({
						message: "Append condition failed: fencing token mismatch",
						code: "APPEND_CONDITION_FAILED",
						status: response.response.status,
						expectedFencingToken: response.error.fencing_token_mismatch,
					});
				} else {
					// fallback for unknown 412 error format
					throw new S2Error({
						message: "Append condition failed",
						status: response.response.status,
					});
				}
			}
		}
		return response.data;
	}
	/**
	 * Open a streaming read session
	 *
	 * Use the returned session as an async iterable or as a readable stream.
	 * When `as: "bytes"` is provided, bodies and headers are decoded to `Uint8Array`.
	 */
	public async readSession<Format extends "string" | "bytes" = "string">(
		args?: ReadArgs<Format>,
		options?: S2RequestOptions,
	): Promise<ReadSession<Format>> {
		return await ReadSession.create(this.client, this.name, args, options);
	}
	/**
	 * Create an append session that guaranteeds ordering of submissions.
	 *
	 * Use this to coordinate high-throughput, sequential appends with backpressure.
	 */
	public async appendSession(
		options?: S2RequestOptions,
	): Promise<AppendSession> {
		return await AppendSession.create(this, options);
	}
}
