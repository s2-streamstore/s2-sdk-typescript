import { S2AccessTokens } from "./accessTokens.js";
import { S2Basin } from "./basin.js";
import { S2Basins } from "./basins.js";
import type { S2ClientOptions } from "./common.js";
import { createClient, createConfig } from "./generated/client/index.js";
import type { Client } from "./generated/client/types.gen.js";
import * as Redacted from "./lib/redacted.js";
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
		this.client = createClient(
			createConfig({
				baseUrl: options.baseUrl ?? defaultBaseUrl,
				auth: () => Redacted.value(this.accessToken),
			}),
		);
		this.basins = new S2Basins(this.client);
		this.accessTokens = new S2AccessTokens(this.client);
		this.metrics = new S2Metrics(this.client);
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
		});
	}
}
