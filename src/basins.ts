import type { DataToObject, S2RequestOptions } from "./common.js";
import { S2Error } from "./error.js";
import type { Client } from "./generated/client/types.gen.js";
import {
	type CreateBasinData,
	createBasin,
	type DeleteBasinData,
	deleteBasin,
	type GetBasinConfigData,
	getBasinConfig,
	type ListBasinsData,
	listBasins,
	type ReconfigureBasinData,
	reconfigureBasin,
} from "./generated/index.js";

export interface ListBasinsArgs extends DataToObject<ListBasinsData> {}
export interface CreateBasinArgs extends DataToObject<CreateBasinData> {}
export interface GetBasinConfigArgs extends DataToObject<GetBasinConfigData> {}
export interface DeleteBasinArgs extends DataToObject<DeleteBasinData> {}
export interface ReconfigureBasinArgs
	extends DataToObject<ReconfigureBasinData> {}

export class S2Basins {
	private readonly client: Client;

	constructor(client: Client) {
		this.client = client;
	}

	/**
	 * List basins.
	 *
	 * @param args.prefix Return basins whose names start with the given prefix
	 * @param args.start_after Name to start after (for pagination)
	 * @param args.limit Max results (up to 1000)
	 */
	public async list(args?: ListBasinsArgs, options?: S2RequestOptions) {
		const response = await listBasins({
			client: this.client,
			query: args,
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
	 * Create a basin.
	 *
	 * @param args.basin Globally unique basin name (8-48 chars, lowercase letters, numbers, hyphens; cannot begin or end with a hyphen)
	 * @param args.config Optional basin configuration (e.g. default stream config)
	 * @param args.scope Basin scope
	 */
	public async create(args: CreateBasinArgs, options?: S2RequestOptions) {
		const response = await createBasin({
			client: this.client,
			body: args,
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
	 * Get basin configuration.
	 *
	 * @param args.basin Basin name
	 */
	public async getConfig(args: GetBasinConfigArgs, options?: S2RequestOptions) {
		const response = await getBasinConfig({
			client: this.client,
			path: args,
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
	 * Delete a basin.
	 *
	 * @param args.basin Basin name
	 */
	public async delete(args: DeleteBasinArgs, options?: S2RequestOptions) {
		const response = await deleteBasin({
			client: this.client,
			path: args,
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
	 * Reconfigure a basin.
	 *
	 * @param args.basin Basin name
	 * @param args.body Configuration fields to change (e.g. default stream config)
	 */
	public async reconfigure(
		args: ReconfigureBasinArgs,
		options?: S2RequestOptions,
	) {
		const response = await reconfigureBasin({
			client: this.client,
			path: args,
			body: args,
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
}
