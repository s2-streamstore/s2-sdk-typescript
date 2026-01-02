import type { RetryConfig, S2RequestOptions } from "./common.js";
import { S2Error, withS2Data } from "./error.js";
import type { Client } from "./generated/client/types.gen.js";
import { checkTail } from "./generated/index.js";
import {
	fromAPIReadBatchBytes,
	fromAPIReadBatchString,
	fromAPITailResponse,
	toAPIReadQuery,
} from "./internal/mappers.js";
import { withRetries } from "./lib/retry.js";
import { createSessionTransport } from "./lib/stream/factory.js";
import {
	streamAppend,
	streamRead,
} from "./lib/stream/transport/fetch/shared.js";
import type {
	AppendSession,
	ReadArgs,
	ReadSession,
	SessionTransport,
	TransportConfig,
} from "./lib/stream/types.js";
import type * as Types from "./types.js";

/**
 * Basin-scoped stream helper for append/read operations.
 *
 * Created via {@link S2Basin.stream}. Provides direct methods plus factories for read/append sessions.
 */
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
	public async checkTail(
		options?: S2RequestOptions,
	): Promise<Types.TailResponse> {
		this.ensureOpen();
		return await withRetries(this.retryConfig, async () => {
			const response = await withS2Data(() =>
				checkTail({
					client: this.client,
					path: {
						stream: this.name,
					},
					...options,
				}),
			);
			return fromAPITailResponse(response);
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
		input?: Types.ReadInput,
		options?: S2RequestOptions & { as?: Format },
	): Promise<Types.ReadBatch<Format>> {
		this.ensureOpen();
		return await withRetries(this.retryConfig, async () => {
			// Convert ReadInput to ReadArgs using mapper
			const readArgs: ReadArgs<Format> = {
				...toAPIReadQuery(input),
				as: options?.as,
			} as ReadArgs<Format>;
			const genBatch = await streamRead(
				this.name,
				this.client,
				readArgs,
				options,
			);
			// Convert from API to SDK ReadBatch
			return (
				options?.as === "bytes"
					? fromAPIReadBatchBytes(genBatch)
					: fromAPIReadBatchString(genBatch)
			) as Types.ReadBatch<Format>;
		});
	}
	/**
	 * Append a batch of records to the stream.
	 *
	 * - Automatically base64-encodes when format is "bytes".
	 * - Supports conditional appends via `fencingToken` and `matchSeqNum` in the input.
	 * - Returns the acknowledged range and the stream tail after the append.
	 * - All records in a batch must use the same format (either all string or all bytes).
	 *
	 * Use {@link AppendInput.create} to construct a validated AppendInput.
	 * For high-throughput sequential appends, use `appendSession()` instead.
	 *
	 * @param input The append input containing records and optional conditions
	 * @param options Optional request options
	 */
	public async append(
		input: Types.AppendInput,
		options?: S2RequestOptions,
	): Promise<Types.AppendAck> {
		this.ensureOpen();
		return await withRetries(
			this.retryConfig,
			async () => {
				return await streamAppend(this.name, this.client, input, options);
			},
			(config, error) => {
				if ((config.appendRetryPolicy ?? "all") === "noSideEffects") {
					// Allow retry only when the append is naturally idempotent by containing
					// a match_seq_num condition.
					return !!input.matchSeqNum;
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
		input?: Types.ReadInput,
		options?: S2RequestOptions & { as?: Format },
	): Promise<ReadSession<Format>> {
		this.ensureOpen();
		const transport = await this.getTransport();
		// Convert ReadInput to ReadArgs using mapper
		const readArgs: ReadArgs<Format> = {
			...toAPIReadQuery(input),
			as: options?.as,
		} as ReadArgs<Format>;
		return await transport.makeReadSession(this.name, readArgs, options);
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
		sessionOptions?: Types.AppendSessionOptions,
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
