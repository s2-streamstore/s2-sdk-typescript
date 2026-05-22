import type { RetryConfig, S2RequestOptions } from "./common.js";
import { withS2Data } from "./error.js";
import type { Client } from "./generated/client/types.gen.js";
import {
	getDefaultLocation,
	listLocations,
	setDefaultLocation,
} from "./generated/index.js";
import { toCamelCase } from "./internal/case-transform.js";
import { withRetries } from "./lib/retry.js";
import type * as Types from "./types.js";

function transformLocationInfo(location: unknown): Types.LocationInfo {
	return toCamelCase<Types.LocationInfo>(location);
}

/**
 * Account-scoped helper for listing locations and managing the default location.
 *
 * Retrieve this via {@link S2.locations}.
 */
export class S2Locations {
	private readonly client: Client;
	private readonly retryConfig: RetryConfig;

	constructor(client: Client, retryConfig: RetryConfig) {
		this.client = client;
		this.retryConfig = retryConfig;
	}

	/**
	 * List available locations.
	 */
	public async list(
		options?: S2RequestOptions,
	): Promise<Types.ListLocationsResponse> {
		const response = await withRetries(this.retryConfig, async () => {
			return await withS2Data(() =>
				listLocations({
					client: this.client,
					...options,
				}),
			);
		});
		return response.map(transformLocationInfo);
	}

	/**
	 * Get the default location used when creating basins without an explicit location.
	 */
	public async getDefault(
		options?: S2RequestOptions,
	): Promise<Types.GetDefaultLocationResponse> {
		const response = await withRetries(this.retryConfig, async () => {
			return await withS2Data(() =>
				getDefaultLocation({
					client: this.client,
					...options,
				}),
			);
		});
		return transformLocationInfo(response);
	}

	/**
	 * Set the default location used when creating basins without an explicit location.
	 *
	 * @param args.location Location name
	 */
	public async setDefault(
		args: Types.SetDefaultLocationInput,
		options?: S2RequestOptions,
	): Promise<Types.SetDefaultLocationResponse> {
		const response = await withRetries(this.retryConfig, async () => {
			return await withS2Data(() =>
				setDefaultLocation({
					client: this.client,
					body: args.location,
					...options,
				}),
			);
		});
		return transformLocationInfo(response);
	}
}
