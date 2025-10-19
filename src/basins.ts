import type { DataToObject, S2RequestOptions } from "./common";
import { S2Error } from "./error";
import {
	type CreateBasinData,
	createBasin,
	type DeleteBasinData,
	deleteBasin,
	type GetBasinConfigData,
	getBasinConfig,
	listBasins,
	type ReconfigureBasinData,
	reconfigureBasin,
} from "./generated";
import type { Client } from "./generated/client/types.gen";

export class S2Basins {
	private readonly client: Client;

	constructor(client: Client) {
		this.client = client;
	}

	/**
	 * List basins.
	 *
	 * @param options.prefix Return basins whose names start with the given prefix
	 * @param options.start_after Name to start after (for pagination)
	 * @param options.limit Max results (up to 1000)
	 */
	public async list(options?: S2RequestOptions) {
		const response = await listBasins({
			client: this.client,
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
	public async create(
		args: DataToObject<CreateBasinData>,
		options?: S2RequestOptions,
	) {
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
	public async getConfig(
		args: DataToObject<GetBasinConfigData>,
		options?: S2RequestOptions,
	) {
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
	public async delete(
		args: DataToObject<DeleteBasinData>,
		options?: S2RequestOptions,
	) {
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
		args: DataToObject<ReconfigureBasinData>,
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
