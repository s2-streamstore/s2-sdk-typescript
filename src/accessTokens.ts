import type { DataToObject, S2RequestOptions } from "./common.js";
import { S2Error } from "./error.js";
import {
	type IssueAccessTokenData,
	issueAccessToken,
	type ListAccessTokensData,
	listAccessTokens,
	type RevokeAccessTokenData,
	revokeAccessToken,
} from "./generated/index.js";
import type { Client } from "./generated/client/types.gen.js";

export interface ListAccessTokensArgs
	extends DataToObject<ListAccessTokensData> {}
export interface IssueAccessTokenArgs
	extends DataToObject<IssueAccessTokenData> {}
export interface RevokeAccessTokenArgs
	extends DataToObject<RevokeAccessTokenData> {}

export class S2AccessTokens {
	readonly client: Client;

	constructor(client: Client) {
		this.client = client;
	}

	/**
	 * List access tokens.
	 *
	 * @param args.prefix Filter to IDs beginning with this prefix
	 * @param args.start_after Filter to IDs lexicographically after this value
	 * @param args.limit Max results (up to 1000)
	 */
	public async list(args?: ListAccessTokensArgs, options?: S2RequestOptions) {
		const response = await listAccessTokens({
			client: this.client,
			query: args,
			...options,
		});

		if (response.error) {
			throw new S2Error({
				message: response.error.message,
				code: response.error.code ?? undefined,
				status: response.response.status,
			});
		}

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
		const response = await issueAccessToken({
			client: this.client,
			body: args,
			...options,
		});

		if (response.error) {
			throw new S2Error({
				message: response.error.message,
				code: response.error.code ?? undefined,
				status: response.response.status,
			});
		}

		return response.data;
	}

	/**
	 * Revoke an access token by ID.
	 *
	 * @param args.id Token ID to revoke
	 */
	public async revoke(args: RevokeAccessTokenArgs, options?: S2RequestOptions) {
		const response = await revokeAccessToken({
			client: this.client,
			path: args,
			...options,
		});

		if (response.error) {
			throw new S2Error({
				message: response.error.message,
				code: response.error.code ?? undefined,
				status: response.response.status,
			});
		}

		return response.data;
	}
}
