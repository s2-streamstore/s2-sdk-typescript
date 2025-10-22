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

export interface ListStreamsOptions extends DataToObject<ListStreamsData> {}
export interface CreateStreamOptions extends DataToObject<CreateStreamData> {}
export interface GetStreamConfigOptions
	extends DataToObject<GetStreamConfigData> {}
export interface DeleteStreamOptions extends DataToObject<DeleteStreamData> {}
export interface ReconfigureStreamOptions
	extends DataToObject<ReconfigureStreamData> {}

export class S2Streams {
	private readonly client: Client;
	constructor(client: Client) {
		this.client = client;
	}

	/**
	 * List streams in the basin.
	 *
	 * @param args.prefix Return streams whose names start with the given prefix
	 * @param args.start_after Name to start after (for pagination)
	 * @param args.limit Max results (up to 1000)
	 */
	public async list(args?: ListStreamsOptions, options?: S2RequestOptions) {
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

	/**
	 * Create a stream.
	 *
	 * @param args.stream Stream name (1-512 bytes, unique within the basin)
	 * @param args.config Stream configuration (retention, storage class, timestamping, delete-on-empty)
	 */
	public async create(args: CreateStreamOptions, options?: S2RequestOptions) {
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

	/**
	 * Get stream configuration.
	 *
	 * @param args.stream Stream name
	 */
	public async getConfig(
		args: GetStreamConfigOptions,
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

	/**
	 * Delete a stream.
	 *
	 * @param args.stream Stream name
	 */
	public async delete(args: DeleteStreamOptions, options?: S2RequestOptions) {
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

	/**
	 * Reconfigure a stream.
	 *
	 * @param args.stream Stream name
	 * @param args.body Configuration fields to change
	 */
	public async reconfigure(
		args: ReconfigureStreamOptions,
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
