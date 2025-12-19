import { S2AccessTokens } from "./accessTokens.js";
import { S2Basin } from "./basin.js";
import { S2Basins } from "./basins.js";
import type { RetryConfig, S2ClientOptions } from "./common.js";
import { makeServerError } from "./error.js";
import { createClient, createConfig } from "./generated/client/index.js";
import type { Client } from "./generated/client/types.gen.js";
import * as Redacted from "./lib/redacted.js";
import {
	canSetUserAgentHeader,
	DEFAULT_USER_AGENT,
} from "./lib/stream/runtime.js";
import { S2Metrics } from "./metrics.js";

const defaultBaseUrl = "https://aws.s2.dev/v1";
const defaultMakeBasinBaseUrl = (basin: string) =>
	`https://${basin}.b.aws.s2.dev/v1`;

/**
 * Top-level S2 SDK client.
 *
 * - Authenticates with an access token and exposes account-scoped helpers for basins, streams, access tokens and metrics.
 */
export class S2 {
	private readonly accessToken: Redacted.Redacted;
	private readonly client: Client;
	private readonly makeBasinBaseUrl: (basin: string) => string;
	private readonly includeBasinHeader: boolean;
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
		const headers: Record<string, string> = {};
		if (canSetUserAgentHeader()) {
			headers["user-agent"] = DEFAULT_USER_AGENT;
		}
		this.client = createClient(
			createConfig({
				baseUrl: options.baseUrl ?? defaultBaseUrl,
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
		this.makeBasinBaseUrl = options.makeBasinBaseUrl ?? defaultMakeBasinBaseUrl;
		this.includeBasinHeader = !!options.makeBasinBaseUrl;
	}

	/**
	 * Create a basin-scoped client bound to a specific basin name.
	 *
	 * @param name Basin name.
	 */
	public basin(name: string) {
		return new S2Basin(name, {
			accessToken: this.accessToken,
			baseUrl: this.makeBasinBaseUrl(name),
			includeBasinHeader: this.includeBasinHeader,
			retryConfig: this.retryConfig,
		});
	}
}
