import type { DataToObject, S2RequestOptions } from "./common";
import { S2Error } from "./error";
import {
	type IssueAccessTokenData,
	issueAccessToken,
	type ListAccessTokensData,
	listAccessTokens,
	type RevokeAccessTokenData,
	revokeAccessToken,
} from "./generated";
import type { Client } from "./generated/client/types.gen";

export class S2AccessTokens {
	readonly client: Client;

	constructor(client: Client) {
		this.client = client;
	}

	public async list(
		args?: DataToObject<ListAccessTokensData>,
		options?: S2RequestOptions,
	) {
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

	public async issue(
		args: DataToObject<IssueAccessTokenData>,
		options?: S2RequestOptions,
	) {
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

	public async revoke(
		args: DataToObject<RevokeAccessTokenData>,
		options?: S2RequestOptions,
	) {
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
