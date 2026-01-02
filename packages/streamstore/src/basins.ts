import type { RetryConfig, S2RequestOptions } from "./common.js";
import { withS2Data } from "./error.js";
import type { Client } from "./generated/client/types.gen.js";
import {
	createBasin,
	deleteBasin,
	getBasinConfig,
	listBasins,
	reconfigureBasin,
} from "./generated/index.js";
import { toCamelCase, toSnakeCase } from "./internal/case-transform.js";
import { randomToken } from "./lib/base64.js";
import { paginate } from "./lib/paginate.js";
import { withRetries } from "./lib/retry.js";
import type * as Types from "./types.js";

export class S2Basins {
	private readonly client: Client;
	private readonly retryConfig: RetryConfig;

	constructor(client: Client, retryConfig: RetryConfig) {
		this.client = client;
		this.retryConfig = retryConfig;
	}

	/**
	 * List basins.
	 *
	 * @param args.prefix Return basins whose names start with the given prefix
	 * @param args.startAfter Name to start after (for pagination)
	 * @param args.limit Max results (up to 1000)
	 */
	public async list(
		args?: Types.ListBasinsInput,
		options?: S2RequestOptions,
	): Promise<Types.ListBasinsResponse> {
		const response = await withRetries(this.retryConfig, async () => {
			return await withS2Data(() =>
				listBasins({
					client: this.client,
					query: toSnakeCase(args),
					...options,
				}),
			);
		});
		return toCamelCase<Types.ListBasinsResponse>(response);
	}

	/**
	 * List all basins with automatic pagination.
	 * Returns a lazy async iterable that fetches pages as needed.
	 *
	 * @param includeDeleted - Include basins that are being deleted (default: false)
	 * @param args - Optional filtering options: `prefix` to filter by name prefix, `limit` for max results per page
	 *
	 * @example
	 * ```ts
	 * for await (const basin of s2.basins.listAll(false, { prefix: "my-" })) {
	 *   console.log(basin.name);
	 * }
	 * ```
	 */
	public listAll(
		includeDeleted = false,
		args?: Types.ListAllBasinsInput,
		options?: S2RequestOptions,
	): AsyncIterable<Types.BasinInfo> {
		return paginate(
			(a) =>
				this.list(a, options).then((r) => ({
					items: r.basins.filter(
						(b) => includeDeleted || b.state !== "deleting",
					),
					hasMore: r.hasMore,
				})),
			args ?? {},
			(basin) => basin.name,
		);
	}

	/**
	 * Create a basin.
	 *
	 * @param args.basin Globally unique basin name (8-48 chars, lowercase letters, numbers, hyphens; cannot begin or end with a hyphen)
	 * @param args.config Optional basin configuration (e.g. defaultStreamConfig)
	 * @param args.scope Basin scope
	 */
	public async create(
		args: Types.CreateBasinInput,
		options?: S2RequestOptions,
	): Promise<Types.CreateBasinResponse> {
		const requestToken = randomToken();
		const response = await withRetries(this.retryConfig, async () => {
			return await withS2Data(() =>
				createBasin({
					client: this.client,
					body: toSnakeCase(args),
					headers: { "s2-request-token": requestToken },
					...options,
				}),
			);
		});
		return toCamelCase<Types.CreateBasinResponse>(response);
	}

	/**
	 * Get basin configuration.
	 *
	 * @param args.basin Basin name
	 */
	public async getConfig(
		args: Types.GetBasinConfigInput,
		options?: S2RequestOptions,
	): Promise<Types.BasinConfig> {
		const response = await withRetries(this.retryConfig, async () => {
			return await withS2Data(() =>
				getBasinConfig({
					client: this.client,
					path: args,
					...options,
				}),
			);
		});
		return toCamelCase<Types.BasinConfig>(response);
	}

	/**
	 * Delete a basin.
	 *
	 * @param args.basin Basin name
	 */
	public async delete(
		args: Types.DeleteBasinInput,
		options?: S2RequestOptions,
	): Promise<void> {
		await withRetries(this.retryConfig, async () => {
			return await withS2Data(() =>
				deleteBasin({
					client: this.client,
					path: args,
					...options,
				}),
			);
		});
	}

	/**
	 * Reconfigure a basin.
	 *
	 * @param args Configuration for the basin to reconfigure (including basin name and fields to change)
	 */
	public async reconfigure(
		args: Types.ReconfigureBasinInput,
		options?: S2RequestOptions,
	): Promise<Types.ReconfigureBasinResponse> {
		const response = await withRetries(this.retryConfig, async () => {
			return await withS2Data(() =>
				reconfigureBasin({
					client: this.client,
					path: args,
					body: toSnakeCase(args),
					...options,
				}),
			);
		});
		return toCamelCase<Types.ReconfigureBasinResponse>(response);
	}
}
