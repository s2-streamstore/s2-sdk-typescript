import { S2AccessTokens } from "./accessTokens.js";
import { S2Basin } from "./basin.js";
import { S2Basins } from "./basins.js";
import type { RetryConfig, S2ClientOptions } from "./common.js";
import { S2Endpoints } from "./endpoints.js";
import { S2Error, makeServerError } from "./error.js";
import { createClient, createConfig } from "./generated/client/index.js";
import type { Client } from "./generated/client/types.gen.js";
import * as Redacted from "./lib/redacted.js";
import {
	canSetUserAgentHeader,
	DEFAULT_USER_AGENT,
} from "./lib/stream/runtime.js";
import { S2Metrics } from "./metrics.js";

/**
 * Basin names must be 8-48 characters, lowercase alphanumeric and hyphens,
 * cannot start or end with a hyphen.
 */
const BASIN_NAME_REGEX = /^[a-z0-9][a-z0-9-]{6,46}[a-z0-9]$/;

/**
 * Top-level S2 SDK client.
 *
 * - Authenticates with an access token and exposes account-scoped helpers for basins, streams, access tokens and metrics.
 */
export class S2 {
	private readonly accessToken: Redacted.Redacted;
	private readonly client: Client;
	private readonly endpoints: S2Endpoints;
	private readonly retryConfig: RetryConfig;

	/**
	 * Account-scoped basin management operations.
	 *
	 * - List, create, delete and reconfigure basins.
	 */
	public readonly basins: S2Basins;
	/** Manage access tokens for the account (list, issue, revoke). */
	public readonly accessTokens: S2AccessTokens;
	/** Account, basin and stream level metrics. */
	public readonly metrics: S2Metrics;

	/**
	 * Create a new S2 client.
	 *
	 * @param options Access token configuration.
	 */
	constructor(options: S2ClientOptions) {
		this.accessToken = Redacted.make(options.accessToken);
		this.retryConfig = options.retry ?? {};
		this.endpoints =
			options.endpoints instanceof S2Endpoints
				? options.endpoints
				: new S2Endpoints(options.endpoints);
		const headers: Record<string, string> = {};
		if (canSetUserAgentHeader()) {
			headers["user-agent"] = DEFAULT_USER_AGENT;
		}
		this.client = createClient(
			createConfig({
				baseUrl: this.endpoints.accountBaseUrl(),
				auth: () => Redacted.value(this.accessToken),
				headers: headers,
			}),
		);

		this.client.interceptors.error.use((err, res) => {
			return makeServerError(res, err);
		});

		this.basins = new S2Basins(this.client, this.retryConfig);
		this.accessTokens = new S2AccessTokens(this.client, this.retryConfig);
		this.metrics = new S2Metrics(this.client, this.retryConfig);
	}

	/**
	 * Create a basin-scoped client bound to a specific basin name.
	 *
	 * @param name Basin name (8-48 characters, lowercase alphanumeric and hyphens, no leading/trailing hyphens).
	 * @throws {S2Error} If the basin name is invalid.
	 */
	public basin(name: string) {
		if (!BASIN_NAME_REGEX.test(name)) {
			throw new S2Error({
				message:
					`Invalid basin name: "${name}". Basin names must be 8-48 characters, ` +
					`contain only lowercase letters, numbers, and hyphens, and cannot start or end with a hyphen.`,
				origin: "sdk",
			});
		}
		return new S2Basin(name, {
			accessToken: this.accessToken,
			baseUrl: this.endpoints.basinBaseUrl(name),
			includeBasinHeader: this.endpoints.includeBasinHeader,
			retryConfig: this.retryConfig,
		});
	}
}
