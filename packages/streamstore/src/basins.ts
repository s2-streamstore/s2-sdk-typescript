import type { DataToObject, RetryConfig, S2RequestOptions } from "./common.js";
import { withS2Data } from "./error.js";
import type { Client } from "./generated/client/types.gen.js";
import {
	type BasinConfig,
	type BasinInfo,
	type CreateBasinData,
	type CreateBasinResponse,
	createBasin,
	type DeleteBasinData,
	deleteBasin,
	type GetBasinConfigData,
	getBasinConfig,
	type ListBasinsData,
	type ListBasinsResponse,
	listBasins,
	type ReconfigureBasinData,
	type ReconfigureBasinResponse,
	reconfigureBasin,
} from "./generated/index.js";
import { randomToken } from "./lib/base64.js";
import { type ListAllArgs, paginate } from "./lib/paginate.js";
import { withRetries } from "./lib/retry.js";

export interface ListBasinsArgs extends DataToObject<ListBasinsData> {}
export interface ListAllBasinsArgs extends ListAllArgs<ListBasinsArgs> {}
export interface CreateBasinArgs extends DataToObject<CreateBasinData> {}
export interface GetBasinConfigArgs extends DataToObject<GetBasinConfigData> {}
export interface DeleteBasinArgs extends DataToObject<DeleteBasinData> {}
export interface ReconfigureBasinArgs
	extends DataToObject<ReconfigureBasinData> {}

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
	 * @param args.start_after Name to start after (for pagination)
	 * @param args.limit Max results (up to 1000)
	 */
	public async list(
		args?: ListBasinsArgs,
		options?: S2RequestOptions,
	): Promise<ListBasinsResponse> {
		return await withRetries(this.retryConfig, async () => {
			return await withS2Data(() =>
				listBasins({
					client: this.client,
					query: args,
					...options,
				}),
			);
		});
	}

	/**
	 * List all basins with automatic pagination.
	 * Returns a lazy async iterable that fetches pages as needed.
	 *
	 * @param includeDeleted Include basins that are being deleted (default: false)
	 * @param args.prefix Return basins whose names start with the given prefix
	 * @param args.limit Max results per page (up to 1000)
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
		args?: ListAllBasinsArgs,
		options?: S2RequestOptions,
	): AsyncIterable<BasinInfo> {
		return paginate(
			(a) =>
				this.list(a, options).then((r) => ({
					items: r.basins.filter(
						(b) => includeDeleted || b.state !== "deleting",
					),
					has_more: r.has_more,
				})),
			args ?? {},
			(basin) => basin.name,
		);
	}

	/**
	 * Create a basin.
	 *
	 * @param args.basin Globally unique basin name (8-48 chars, lowercase letters, numbers, hyphens; cannot begin or end with a hyphen)
	 * @param args.config Optional basin configuration (e.g. default stream config)
	 * @param args.scope Basin scope
	 */
	public async create(
		args: CreateBasinArgs,
		options?: S2RequestOptions,
	): Promise<CreateBasinResponse> {
		const requestToken = randomToken();
		return await withRetries(this.retryConfig, async () => {
			return await withS2Data(() =>
				createBasin({
					client: this.client,
					body: args,
					headers: { "s2-request-token": requestToken },
					...options,
				}),
			);
		});
	}

	/**
	 * Get basin configuration.
	 *
	 * @param args.basin Basin name
	 */
	public async getConfig(
		args: GetBasinConfigArgs,
		options?: S2RequestOptions,
	): Promise<BasinConfig> {
		return await withRetries(this.retryConfig, async () => {
			return await withS2Data(() =>
				getBasinConfig({
					client: this.client,
					path: args,
					...options,
				}),
			);
		});
	}

	/**
	 * Delete a basin.
	 *
	 * @param args.basin Basin name
	 */
	public async delete(
		args: DeleteBasinArgs,
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
		args: ReconfigureBasinArgs,
		options?: S2RequestOptions,
	): Promise<ReconfigureBasinResponse> {
		return await withRetries(this.retryConfig, async () => {
			return await withS2Data(() =>
				reconfigureBasin({
					client: this.client,
					path: args,
					body: args,
					...options,
				}),
			);
		});
	}
}
