import type { RetryConfig, S2RequestOptions } from "./common.js";
import { withS2Data } from "./error.js";
import type { Client } from "./generated/client/types.gen.js";
import {
	issueAccessToken,
	listAccessTokens,
	revokeAccessToken,
} from "./generated/index.js";
import { toCamelCase, toSnakeCase } from "./internal/case-transform.js";
import { paginate } from "./lib/paginate.js";
import { withRetries } from "./lib/retry.js";
import type * as Types from "./types.js";

/** Convert expiresAt input (Date, milliseconds, or string) to RFC 3339 string for API. */
function toISOString(
	value: Date | number | string | null | undefined,
): string | null | undefined {
	if (value === null) return null;
	if (value === undefined) return undefined;
	if (value instanceof Date) return value.toISOString();
	if (typeof value === "number") return new Date(value).toISOString();
	return value;
}

/** Convert expiresAt from API (ISO string) to Date. */
function toDate(value: string | null | undefined): Date | null | undefined {
	if (value === null) return null;
	if (value === undefined) return undefined;
	return new Date(value);
}

/** Transform AccessTokenInfo response: convert expiresAt to Date. */
function transformTokenInfo(token: any): Types.AccessTokenInfo {
	return {
		...token,
		expiresAt: toDate(token.expiresAt),
	};
}

/**
 * Account-scoped helper for listing, issuing, and revoking access tokens.
 *
 * Acquire via {@link S2.accessTokens}. Use {@link S2AccessTokens.listAll} for async iteration.
 */
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
	 * @param args.startAfter Filter to IDs lexicographically after this value
	 * @param args.limit Max results (up to 1000)
	 */
	public async list(
		args?: Types.ListAccessTokensInput,
		options?: S2RequestOptions,
	): Promise<Types.ListAccessTokensResponse> {
		const response = await withRetries(this.retryConfig, async () => {
			return await withS2Data(() =>
				listAccessTokens({
					client: this.client,
					query: toSnakeCase(args),
					...options,
				}),
			);
		});
		const camelCased = toCamelCase<any>(response);
		return {
			...camelCased,
			accessTokens: camelCased.accessTokens.map(transformTokenInfo),
		};
	}

	/**
	 * List all access tokens with automatic pagination.
	 * Returns a lazy async iterable that fetches pages as needed.
	 *
	 * @param args - Optional filtering options: `prefix` to filter by ID prefix, `limit` for max results per page
	 *
	 * @example
	 * ```ts
	 * for await (const token of s2.accessTokens.listAll({ prefix: "service-" })) {
	 *   console.log(token.id);
	 * }
	 * ```
	 */
	public listAll(
		args?: Types.ListAllAccessTokensInput,
		options?: S2RequestOptions,
	): AsyncIterable<Types.AccessTokenInfo> {
		return paginate(
			(a) =>
				this.list(a, options).then((r) => ({
					items: r.accessTokens,
					hasMore: r.hasMore,
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
	 * @param args.autoPrefixStreams Namespace stream names by configured prefix scope
	 * @param args.expiresAt Expiration time (Date or RFC 3339 string); defaults to requestor's token expiry
	 */
	public async issue(
		args: Types.IssueAccessTokenInput,
		options?: S2RequestOptions,
	): Promise<Types.IssueAccessTokenResponse> {
		// Convert Date to ISO string for API
		const apiArgs = {
			...args,
			expiresAt: toISOString(args.expiresAt),
		};
		const response = await withRetries(this.retryConfig, async () => {
			return await withS2Data(() =>
				issueAccessToken({
					client: this.client,
					body: toSnakeCase(apiArgs),
					...options,
				}),
			);
		});
		return toCamelCase<Types.IssueAccessTokenResponse>(response);
	}

	/**
	 * Revoke an access token by ID.
	 *
	 * @param args.id Token ID to revoke
	 */
	public async revoke(
		args: Types.RevokeAccessTokenInput,
		options?: S2RequestOptions,
	): Promise<void> {
		await withRetries(this.retryConfig, async () => {
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
