import type { DataToObject, RetryConfig, S2RequestOptions } from "./common.js";
import { S2Error, withS2Error } from "./error.js";
import type { Client } from "./generated/client/types.gen.js";
import {
	type IssueAccessTokenData,
	issueAccessToken,
	type ListAccessTokensData,
	listAccessTokens,
	type RevokeAccessTokenData,
	revokeAccessToken,
} from "./generated/index.js";
import { withRetries } from "./lib/retry.js";

export interface ListAccessTokensArgs
	extends DataToObject<ListAccessTokensData> {}
export interface IssueAccessTokenArgs
	extends DataToObject<IssueAccessTokenData> {}
export interface RevokeAccessTokenArgs
	extends DataToObject<RevokeAccessTokenData> {}

export class S2AccessTokens {
	readonly client: Client;
	private readonly retryConfig?: RetryConfig;

	constructor(client: Client, retryConfig?: RetryConfig) {
		this.client = client;
		this.retryConfig = retryConfig;
	}

	/**
	 * List access tokens.
	 *
	 * @param args.prefix Filter to IDs beginning with this prefix
	 * @param args.start_after Filter to IDs lexicographically after this value
	 * @param args.limit Max results (up to 1000)
	 */
	public async list(args?: ListAccessTokensArgs, options?: S2RequestOptions) {
		const response = await withRetries(this.retryConfig, async () => {
            return await withS2Error(async () =>
                listAccessTokens({
                    client: this.client,
                    query: args,
                    ...options,
                }),
            );
		});

		return response.data;
	}

	/**
	 * Issue a new access token.
	 *
	 * @param args.id Unique token ID (1-96 bytes)
	 * @param args.scope Token scope (operations and resource sets)
	 * @param args.auto_prefix_streams Namespace stream names by configured prefix scope
	 * @param args.expires_at Expiration in ISO 8601; defaults to requestor's token expiry
	 */
	public async issue(args: IssueAccessTokenArgs, options?: S2RequestOptions) {
		const response = await withRetries(this.retryConfig, async () => {
            return await withS2Error(async () =>
                issueAccessToken({
                    client: this.client,
                    body: args,
                    ...options,
                }),
            );
		});

		return response.data;
	}

	/**
	 * Revoke an access token by ID.
	 *
	 * @param args.id Token ID to revoke
	 */
	public async revoke(args: RevokeAccessTokenArgs, options?: S2RequestOptions) {
		const response = await withRetries(this.retryConfig, async () => {
            return await withS2Error(async () =>
                revokeAccessToken({
                    client: this.client,
                    path: args,
                    ...options,
                }),
            );
		});

		return response.data;
	}
}
