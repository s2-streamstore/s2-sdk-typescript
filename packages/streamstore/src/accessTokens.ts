import type { DataToObject, RetryConfig, S2RequestOptions } from "./common.js";
import { S2Error, withS2Data } from "./error.js";
import type { Client } from "./generated/client/types.gen.js";
import {
	type AccessTokenInfo,
	type IssueAccessTokenData,
	issueAccessToken,
	type ListAccessTokensData,
	listAccessTokens,
	type RevokeAccessTokenData,
	revokeAccessToken,
} from "./generated/index.js";
import { type ListAllArgs, paginate } from "./lib/paginate.js";
import { withRetries } from "./lib/retry.js";

export interface ListAccessTokensArgs
	extends DataToObject<ListAccessTokensData> {}
export interface ListAllAccessTokensArgs
	extends ListAllArgs<ListAccessTokensArgs> {}
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
		return await withRetries(this.retryConfig, async () => {
			return await withS2Data(() =>
				listAccessTokens({
					client: this.client,
					query: args,
					...options,
				}),
			);
		});
	}

	/**
	 * List all access tokens with automatic pagination.
	 * Returns a lazy async iterable that fetches pages as needed.
	 *
	 * @param args.prefix Filter to IDs beginning with this prefix
	 * @param args.limit Max results per page (up to 1000)
	 *
	 * @example
	 * ```ts
	 * for await (const token of s2.accessTokens.listAll({ prefix: "service-" })) {
	 *   console.log(token.id);
	 * }
	 * ```
	 */
	public listAll(
		args?: ListAllAccessTokensArgs,
		options?: S2RequestOptions,
	): AsyncIterable<AccessTokenInfo> {
		return paginate(
			(a) =>
				this.list(a, options).then((r) => ({
					items: r.access_tokens,
					has_more: r.has_more,
				})),
			args ?? {},
			(token) => token.id,
		);
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
		return await withRetries(this.retryConfig, async () => {
			return await withS2Data(() =>
				issueAccessToken({
					client: this.client,
					body: args,
					...options,
				}),
			);
		});
	}

	/**
	 * Revoke an access token by ID.
	 *
	 * @param args.id Token ID to revoke
	 */
	public async revoke(args: RevokeAccessTokenArgs, options?: S2RequestOptions) {
		return await withRetries(this.retryConfig, async () => {
			return await withS2Data(() =>
				revokeAccessToken({
					client: this.client,
					path: args,
					...options,
				}),
			);
		});
	}
}
