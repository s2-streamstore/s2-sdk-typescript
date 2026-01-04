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
import type * as API from "./generated/types.gen.js";
import { toCamelCase, toSnakeCase } from "./internal/case-transform.js";
import { randomToken } from "./lib/base64.js";
import { paginate } from "./lib/paginate.js";
import { withRetries } from "./lib/retry.js";
import type * as Types from "./types.js";

/** Convert SDK RetentionPolicy (ageSecs) to API RetentionPolicy (age). */
function toAPIRetentionPolicy(
	policy: Types.RetentionPolicy | null | undefined,
): API.RetentionPolicy | null | undefined {
	if (policy === null) return null;
	if (policy === undefined) return undefined;
	if ("ageSecs" in policy) {
		return { age: Math.floor(policy.ageSecs) };
	}
	return policy; // { infinite: ... } passes through
}

/** Convert API RetentionPolicy (age) to SDK RetentionPolicy (ageSecs). */
function toSDKRetentionPolicy(
	policy: API.RetentionPolicy | null | undefined,
): Types.RetentionPolicy | null | undefined {
	if (policy === null) return null;
	if (policy === undefined) return undefined;
	if ("age" in policy) {
		return { ageSecs: policy.age };
	}
	return policy; // { infinite: ... } passes through
}

/** Convert SDK StreamConfig to API format (handles retentionPolicy.ageSecs → age). */
function toAPIStreamConfig(config: Types.StreamConfig | null | undefined): any {
	if (config === null || config === undefined) return config;
	return {
		...config,
		deleteOnEmpty: config.deleteOnEmpty
			? {
					...config.deleteOnEmpty,
					minAgeSecs:
						config.deleteOnEmpty.minAgeSecs === undefined
							? undefined
							: Math.max(0, Math.floor(config.deleteOnEmpty.minAgeSecs)),
				}
			: config.deleteOnEmpty,
		retentionPolicy: toAPIRetentionPolicy(config.retentionPolicy),
	};
}

/** Convert API StreamConfig to SDK format (handles retentionPolicy.age → ageSecs). */
function toSDKStreamConfig(config: any): Types.StreamConfig | null | undefined {
	if (config === null || config === undefined) return config;
	return {
		...config,
		retentionPolicy: toSDKRetentionPolicy(config?.retentionPolicy),
	};
}

/** Convert SDK BasinConfig to API format. */
function toAPIBasinConfig(config: Types.BasinConfig | null | undefined): any {
	if (config === null || config === undefined) return config;
	return {
		...config,
		defaultStreamConfig: toAPIStreamConfig(config.defaultStreamConfig),
	};
}

/** Convert API BasinConfig to SDK format. */
function toSDKBasinConfig(config: any): Types.BasinConfig {
	return {
		...config,
		defaultStreamConfig: toSDKStreamConfig(config?.defaultStreamConfig),
	};
}

/**
 * Account-scoped helper for listing, creating, deleting, and reconfiguring basins.
 *
 * Retrieve this via {@link S2.basins}. Each method retries according to the client-level retry config.
 */
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
		// Convert SDK config to API format (ageSecs → age)
		const apiArgs = {
			...args,
			config: toAPIBasinConfig(args.config),
		};
		const response = await withRetries(this.retryConfig, async () => {
			return await withS2Data(() =>
				createBasin({
					client: this.client,
					body: toSnakeCase(apiArgs),
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
		// Convert API format to SDK (age → ageSecs)
		return toSDKBasinConfig(toCamelCase(response));
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
		// Convert SDK config to API format (ageSecs → age)
		const apiArgs = {
			...args,
			defaultStreamConfig: toAPIStreamConfig(args.defaultStreamConfig),
		};
		const response = await withRetries(this.retryConfig, async () => {
			return await withS2Data(() =>
				reconfigureBasin({
					client: this.client,
					path: args,
					body: toSnakeCase(apiArgs),
					...options,
				}),
			);
		});
		// Convert API format to SDK (age → ageSecs)
		return toSDKBasinConfig(toCamelCase(response));
	}
}
