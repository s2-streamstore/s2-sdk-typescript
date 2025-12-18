import type { RetryConfig, S2RequestOptions } from "./common.js";
import { S2Error, withS2Data } from "./error.js";
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
	private closed = false;
	private closePromise?: Promise<void>;

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
		this.ensureOpen();
		if (!this._transport) {
			this._transport = await createSessionTransport(this.transportConfig);
		}
		return this._transport;
	}

	private ensureOpen(): void {
		if (this.closed) {
			throw new S2Error({ message: "S2Stream is closed" });
		}
	}

	/**
	 * Check the tail of the stream.
	 *
	 * Returns the next sequence number and timestamp to be assigned (`tail`).
	 */
	public async checkTail(options?: S2RequestOptions) {
		this.ensureOpen();
		return await withRetries(this.retryConfig, async () => {
			return await withS2Data(() =>
				checkTail({
					client: this.client,
					path: {
						stream: this.name,
					},
					...options,
				}),
			);
		});
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
		this.ensureOpen();
		return await withRetries(this.retryConfig, async () => {
			return await streamRead(this.name, this.client, args, options);
		});
	}
	/**
	 * Append one or more records to the stream.
	 *
	 * - Automatically base64-encodes when format is "bytes".
	 * - Supports conditional appends via `fencingToken` and `matchSeqNum`.
	 * - Returns the acknowledged range and the stream tail after the append.
	 *
	 * All records in a single append call must use the same format (either all string or all bytes).
	 * For high-throughput sequential appends, use `appendSession()` instead.
	 *
	 * @param records The record(s) to append
	 * @param args Optional append arguments (fencingToken, matchSeqNum)
	 * @param options Optional request options
	 */
	public async append(
		records: AppendRecord | AppendRecord[],
		args?: Omit<AppendArgs, "records">,
		options?: S2RequestOptions,
	): Promise<AppendAck> {
		this.ensureOpen();
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
				if ((config.appendRetryPolicy ?? "all") === "noSideEffects") {
					// Allow retry only when the append is naturally idempotent by containing
					// a matchSeqNum condition.
					return !!args?.matchSeqNum;
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
		this.ensureOpen();
		const transport = await this.getTransport();
		return await transport.makeReadSession(this.name, args, options);
	}
	/**
	 * Create an append session that guarantees ordering of submissions.
	 *
	 * Use this to coordinate high-throughput, sequential appends with backpressure.
	 * Records can be either string or bytes format - the format is specified in each record.
	 *
	 * @param sessionOptions Options that control append session behavior
	 * @param requestOptions Optional request options
	 */
	public async appendSession(
		sessionOptions?: AppendSessionOptions,
		requestOptions?: S2RequestOptions,
	): Promise<AppendSession> {
		this.ensureOpen();
		const transport = await this.getTransport();
		return await transport.makeAppendSession(
			this.name,
			sessionOptions,
			requestOptions,
		);
	}
	public async close(): Promise<void> {
		if (this.closePromise) {
			return this.closePromise;
		}

		this.closePromise = (async () => {
			if (this.closed) {
				return;
			}
			this.closed = true;
			if (this._transport) {
				try {
					await this._transport.close();
				} finally {
					this._transport = undefined;
				}
			}
		})();

		try {
			await this.closePromise;
		} finally {
			this.closePromise = undefined;
		}
	}

	async [Symbol.asyncDispose](): Promise<void> {
		await this.close();
	}
}
