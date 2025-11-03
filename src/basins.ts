import type { DataToObject, RetryConfig, S2RequestOptions } from "./common.js";
import { S2Error, withS2Error } from "./error.js";
import type { Client } from "./generated/client/types.gen.js";
import {
	type BasinConfig,
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
import { withRetries } from "./lib/retry.js";

export interface ListBasinsArgs extends DataToObject<ListBasinsData> {}
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
		const response = await withRetries(this.retryConfig, async () => {
			return await withS2Error(async () =>
				listBasins({
					client: this.client,
					query: args,
					...options,
					throwOnError: true,
				}),
			);
		});

		return response.data;
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
		const response = await withRetries(this.retryConfig, async () => {
			return await withS2Error(async () =>
				createBasin({
					client: this.client,
					body: args,
					...options,
					throwOnError: true,
				}),
			);
		});

		return response.data;
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
		const response = await withRetries(this.retryConfig, async () => {
			return await withS2Error(async () =>
				getBasinConfig({
					client: this.client,
					path: args,
					...options,
					throwOnError: true,
				}),
			);
		});

		return response.data;
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
			return await withS2Error(async () =>
				deleteBasin({
					client: this.client,
					path: args,
					...options,
					throwOnError: true,
				}),
			);
		});
	}

	/**
	 * Reconfigure a basin.
	 *
	 * @param args.basin Basin name
	 * @param args.body Configuration fields to change (e.g. default stream config)
	 */
	public async reconfigure(
		args: ReconfigureBasinArgs,
		options?: S2RequestOptions,
	): Promise<ReconfigureBasinResponse> {
		const response = await withRetries(this.retryConfig, async () => {
			return await withS2Error(async () =>
				reconfigureBasin({
					client: this.client,
					path: args,
					body: args,
					...options,
					throwOnError: true,
				}),
			);
		});

		return response.data;
	}
}
