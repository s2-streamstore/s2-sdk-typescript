import { S2AccessTokens } from "./accessTokens";
import { S2Basin } from "./basin";
import { S2Basins } from "./basins";
import type { S2ClientOptions } from "./common";
import { createClient, createConfig } from "./generated/client";
import type { Client } from "./generated/client/types.gen";
import * as Redacted from "./lib/redacted";
import { S2Metrics } from "./metrics";

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
		});
	}
}
