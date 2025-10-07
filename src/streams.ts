import type { DataToObject, S2RequestOptions } from "./common";
import { S2Error } from "./error";
import {
	type CreateStreamData,
	createStream,
	type DeleteStreamData,
	deleteStream,
	type GetStreamConfigData,
	getStreamConfig,
	type ListStreamsData,
	listStreams,
	type ReconfigureStreamData,
	reconfigureStream,
} from "./generated";
import type { Client } from "./generated/client/types.gen";

export class S2Streams {
	private readonly client: Client;
	constructor(client: Client) {
		this.client = client;
	}

	public async list(
		args?: DataToObject<ListStreamsData>,
		options?: S2RequestOptions,
	) {
		const response = await listStreams({
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

	public async create(
		args: DataToObject<CreateStreamData>,
		options?: S2RequestOptions,
	) {
		const response = await createStream({
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

	public async getConfig(
		args: DataToObject<GetStreamConfigData>,
		options?: S2RequestOptions,
	) {
		const response = await getStreamConfig({
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

	public async delete(
		args: DataToObject<DeleteStreamData>,
		options?: S2RequestOptions,
	) {
		const response = await deleteStream({
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

	public async reconfigure(
		args: DataToObject<ReconfigureStreamData>,
		options?: S2RequestOptions,
	) {
		const response = await reconfigureStream({
			client: this.client,
			path: args,
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
}
