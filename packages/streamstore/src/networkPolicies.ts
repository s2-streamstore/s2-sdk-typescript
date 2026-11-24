import type { RetryConfig, S2RequestOptions } from "./common.js";
import { withS2Data } from "./error.js";
import type { Client } from "./generated/client/types.gen.js";
import {
	createNetworkPolicy,
	deleteNetworkPolicy,
	getNetworkPolicy,
	listNetworkPolicies,
} from "./generated/index.js";
import { toCamelCase, toSnakeCase } from "./internal/case-transform.js";
import { paginate } from "./lib/paginate.js";
import { withRetries } from "./lib/retry.js";
import type * as Types from "./types.js";

/** Transform NetworkPolicyInfo response: camelCase keys and convert createdAt to Date. */
function transformPolicyInfo(policy: unknown): Types.NetworkPolicyInfo {
	const camelCased = toCamelCase<any>(policy);
	return { ...camelCased, createdAt: new Date(camelCased.createdAt) };
}

/**
 * Account-scoped helper for listing, creating, getting, and deleting network policies.
 *
 * A network policy restricts where an access token may be used from. Bind one when
 * issuing a token with {@link S2AccessTokens.issue}.
 *
 * Acquire via {@link S2.networkPolicies}. Use {@link S2NetworkPolicies.listAll} for async iteration.
 */
export class S2NetworkPolicies {
	readonly client: Client;
	private readonly retryConfig?: RetryConfig;

	constructor(client: Client, retryConfig?: RetryConfig) {
		this.client = client;
		this.retryConfig = retryConfig;
	}

	/**
	 * List network policies.
	 *
	 * @param args.prefix Filter to slugs beginning with this prefix
	 * @param args.startAfter Filter to slugs lexicographically after this value
	 * @param args.limit Max results (up to 1000)
	 */
	public async list(
		args?: Types.ListNetworkPoliciesInput,
		options?: S2RequestOptions,
	): Promise<Types.ListNetworkPoliciesResponse> {
		const query = toSnakeCase<any>(args);
		const requestOptions = options ? { ...options } : undefined;
		const response = await withRetries(this.retryConfig, async () => {
			return await withS2Data(() =>
				listNetworkPolicies({
					client: this.client,
					query,
					...requestOptions,
				}),
			);
		});
		return {
			networkPolicies: response.network_policies.map(transformPolicyInfo),
			hasMore: response.has_more,
		};
	}

	/**
	 * List all network policies with automatic pagination.
	 * Returns a lazy async iterable that fetches pages as needed.
	 *
	 * @param args - Optional filtering options: `prefix` to filter by slug prefix, `limit` for max results per page
	 */
	public listAll(
		args?: Types.ListAllNetworkPoliciesInput,
		options?: S2RequestOptions,
	): AsyncIterable<Types.NetworkPolicyInfo> {
		const listArgs = args ? { ...args } : {};
		const requestOptions = options ? { ...options } : undefined;
		return paginate(
			(a) =>
				this.list(a, requestOptions).then((r) => ({
					items: r.networkPolicies,
					hasMore: r.hasMore,
				})),
			listArgs,
			(policy) => policy.slug,
		);
	}

	/**
	 * Create a network policy.
	 *
	 * @param args.slug Slug, unique to the account
	 * @param args.policy The restriction; policies are immutable
	 */
	public async create(
		args: Types.CreateNetworkPolicyInput,
		options?: S2RequestOptions,
	): Promise<Types.NetworkPolicyInfo> {
		const { slug, policy } = args;
		const publicNet = policy?.publicNet;
		const privateNet = policy?.privateNet;
		const body = toSnakeCase<any>({
			slug,
			policy: policy
				? {
						...(publicNet !== undefined
							? {
									publicNet:
										publicNet === null ? null : { cidrs: [...publicNet.cidrs] },
								}
							: {}),
						...(privateNet !== undefined
							? {
									privateNet:
										privateNet === null
											? null
											: {
													aws: privateNet.aws
														? { vpceIds: [...privateNet.aws.vpceIds] }
														: privateNet.aws,
												},
								}
							: {}),
					}
				: policy,
		});
		const requestOptions = options ? { ...options } : undefined;
		const response = await withRetries(this.retryConfig, async () => {
			return await withS2Data(() =>
				createNetworkPolicy({
					client: this.client,
					body,
					...requestOptions,
				}),
			);
		});
		return transformPolicyInfo(response);
	}

	/**
	 * Get a network policy.
	 *
	 * @param args.id Slug, or full `<slug>.<nonce>` reference
	 */
	public async get(
		args: Types.GetNetworkPolicyInput,
		options?: S2RequestOptions,
	): Promise<Types.NetworkPolicyInfo> {
		const { id } = args;
		const requestOptions = options ? { ...options } : undefined;
		const response = await withRetries(this.retryConfig, async () => {
			return await withS2Data(() =>
				getNetworkPolicy({
					client: this.client,
					path: { id },
					...requestOptions,
				}),
			);
		});
		return transformPolicyInfo(response);
	}

	/**
	 * Delete a network policy.
	 *
	 * @param args.id Slug, or full `<slug>.<nonce>` reference
	 */
	public async delete(
		args: Types.DeleteNetworkPolicyInput,
		options?: S2RequestOptions,
	): Promise<void> {
		const { id } = args;
		const requestOptions = options ? { ...options } : undefined;
		await withRetries(this.retryConfig, async () => {
			return await withS2Data(() =>
				deleteNetworkPolicy({
					client: this.client,
					path: { id },
					...requestOptions,
				}),
			);
		});
	}
}
