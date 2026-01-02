import type { RetryConfig, S2RequestOptions } from "./common.js";
import { withS2Data } from "./error.js";
import type { Client } from "./generated/client/types.gen.js";
import {
	createStream,
	deleteStream,
	getStreamConfig,
	listStreams,
	reconfigureStream,
} from "./generated/index.js";
import { toCamelCase, toSnakeCase } from "./internal/case-transform.js";
import { randomToken } from "./lib/base64.js";
import { paginate } from "./lib/paginate.js";
import { withRetries } from "./lib/retry.js";
import type * as Types from "./types.js";

export class S2Streams {
	private readonly client: Client;
	private readonly retryConfig?: RetryConfig;

	constructor(client: Client, retryConfig?: RetryConfig) {
		this.client = client;
		this.retryConfig = retryConfig;
	}

	/**
	 * List streams in the basin.
	 *
	 * @param args.prefix Return streams whose names start with the given prefix
	 * @param args.startAfter Name to start after (for pagination)
	 * @param args.limit Max results (up to 1000)
	 */
	public async list(
		args?: Types.ListStreamsInput,
		options?: S2RequestOptions,
	): Promise<Types.ListStreamsResponse> {
		const response = await withRetries(this.retryConfig, async () => {
			return await withS2Data(() =>
				listStreams({
					client: this.client,
					query: toSnakeCase(args),
					...options,
				}),
			);
		});
		return toCamelCase<Types.ListStreamsResponse>(response);
	}

	/**
	 * List all streams in the basin with automatic pagination.
	 * Returns a lazy async iterable that fetches pages as needed.
	 *
	 * @param includeDeleted - Include deleted streams (default: false)
	 * @param args - Optional filtering options: `prefix` to filter by name prefix, `limit` for max results per page
	 *
	 * @example
	 * ```ts
	 * for await (const stream of basin.streams.listAll({ prefix: "events-" })) {
	 *   console.log(stream.name);
	 * }
	 * ```
	 */
	public listAll(
		includeDeleted = false,
		args?: Types.ListAllStreamsInput,
		options?: S2RequestOptions,
	): AsyncIterable<Types.StreamInfo> {
		return paginate(
			(a) =>
				this.list(a, options).then((r) => ({
					items: r.streams.filter((s) => includeDeleted || !s.deletedAt),
					hasMore: r.hasMore,
				})),
			args ?? {},
			(stream) => stream.name,
		);
	}

	/**
	 * Create a stream.
	 *
	 * @param args.stream Stream name (1-512 bytes, unique within the basin)
	 * @param args.config Stream configuration (retentionPolicy, storageClass, timestamping, deleteOnEmpty)
	 */
	public async create(
		args: Types.CreateStreamInput,
		options?: S2RequestOptions,
	): Promise<Types.CreateStreamResponse> {
		const requestToken = randomToken();
		const response = await withRetries(this.retryConfig, async () => {
			return await withS2Data(() =>
				createStream({
					client: this.client,
					body: toSnakeCase(args),
					headers: { "s2-request-token": requestToken },
					...options,
				}),
			);
		});
		return toCamelCase<Types.CreateStreamResponse>(response);
	}

	/**
	 * Get stream configuration.
	 *
	 * @param args.stream Stream name
	 */
	public async getConfig(
		args: Types.GetStreamConfigInput,
		options?: S2RequestOptions,
	): Promise<Types.StreamConfig> {
		const response = await withRetries(this.retryConfig, async () => {
			return await withS2Data(() =>
				getStreamConfig({
					client: this.client,
					path: args,
					...options,
				}),
			);
		});
		return toCamelCase<Types.StreamConfig>(response);
	}

	/**
	 * Delete a stream.
	 *
	 * @param args.stream Stream name
	 */
	public async delete(
		args: Types.DeleteStreamInput,
		options?: S2RequestOptions,
	): Promise<void> {
		await withRetries(this.retryConfig, async () => {
			return await withS2Data(() =>
				deleteStream({
					client: this.client,
					path: args,
					...options,
				}),
			);
		});
	}

	/**
	 * Reconfigure a stream.
	 *
	 * @param args Configuration for the stream to reconfigure (including stream name and fields to change)
	 */
	public async reconfigure(
		args: Types.ReconfigureStreamInput,
		options?: S2RequestOptions,
	): Promise<Types.ReconfigureStreamResponse> {
		const response = await withRetries(this.retryConfig, async () => {
			return await withS2Data(() =>
				reconfigureStream({
					client: this.client,
					path: args,
					body: toSnakeCase(args),
					...options,
				}),
			);
		});
		return toCamelCase<Types.ReconfigureStreamResponse>(response);
	}
}
