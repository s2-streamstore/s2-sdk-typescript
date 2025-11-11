import type { RetryConfig, S2RequestOptions } from "./common.js";
import { withS2Error } from "./error.js";
import type { Client } from "./generated/client/types.gen.js";
import { type AppendAck, checkTail } from "./generated/index.js";
import { isRetryable, withRetries } from "./lib/retry.js";
import { createSessionTransport } from "./lib/stream/factory.js";
import {
	streamAppend,
	streamRead,
} from "./lib/stream/transport/fetch/shared.js";
import type {
	AppendArgs,
	AppendRecord,
	AppendSession,
	AppendSessionOptions,
	ReadArgs,
	ReadBatch,
	ReadSession,
	SessionTransport,
	TransportConfig,
} from "./lib/stream/types.js";

export class S2Stream {
	private readonly client: Client;
	private readonly transportConfig: TransportConfig;
	private readonly retryConfig?: RetryConfig;
	private _transport?: SessionTransport;

	public readonly name: string;

	constructor(
		name: string,
		client: Client,
		transportConfig: TransportConfig,
		retryConfig?: RetryConfig,
	) {
		this.name = name;
		this.client = client;
		this.transportConfig = transportConfig;
		this.retryConfig = retryConfig;
	}

	/**
	 * Get or create the transport instance
	 */
	private async getTransport(): Promise<SessionTransport> {
		if (!this._transport) {
			this._transport = await createSessionTransport(this.transportConfig);
		}
		return this._transport;
	}

	/**
	 * Check the tail of the stream.
	 *
	 * Returns the next sequence number and timestamp to be assigned (`tail`).
	 */
	public async checkTail(options?: S2RequestOptions) {
		const response = await withRetries(this.retryConfig, async () => {
			return await withS2Error(async () =>
				checkTail({
					client: this.client,
					path: {
						stream: this.name,
					},
					...options,
					throwOnError: true,
				}),
			);
		});

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
		return await withRetries(this.retryConfig, async () => {
			return await streamRead(this.name, this.client, args, options);
		});
	}
	/**
	 * Append one or more records to the stream.
	 *
	 * - Automatically base64-encodes when format is "bytes".
	 * - Supports conditional appends via `fencing_token` and `match_seq_num`.
	 * - Returns the acknowledged range and the stream tail after the append.
	 *
	 * All records in a single append call must use the same format (either all string or all bytes).
	 * For high-throughput sequential appends, use `appendSession()` instead.
	 *
	 * @param records The record(s) to append
	 * @param args Optional append arguments (fencing_token, match_seq_num)
	 * @param options Optional request options
	 */
	public async append(
		records: AppendRecord | AppendRecord[],
		args?: Omit<AppendArgs, "records">,
		options?: S2RequestOptions,
	): Promise<AppendAck> {
		return await withRetries(
			this.retryConfig,
			async () => {
				return await streamAppend(
					this.name,
					this.client,
					records,
					args,
					options,
				);
			},
			(config, error) => {
				if ((config.appendRetryPolicy ?? "noSideEffects") === "noSideEffects") {
					// Allow retry if the append is idempotent (match_seq_num or fencing_token)
					// or if the error qualifies as retryable by shared logic.
					const isIdempotent = !!args?.match_seq_num || !!args?.fencing_token;
					return isIdempotent || isRetryable(error);
				} else {
					return true;
				}
			},
		);
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
		const transport = await this.getTransport();
		return await transport.makeReadSession(this.name, args, options);
	}
	/**
	 * Create an append session that guarantees ordering of submissions.
	 *
	 * Use this to coordinate high-throughput, sequential appends with backpressure.
	 * Records can be either string or bytes format - the format is specified in each record.
	 *
	 * @param options Optional request options
	 */
	public async appendSession(
		sessionOptions?: AppendSessionOptions,
		requestOptions?: S2RequestOptions,
	): Promise<AppendSession> {
		const transport = await this.getTransport();
		return await transport.makeAppendSession(
			this.name,
			sessionOptions,
			requestOptions,
		);
	}
}
