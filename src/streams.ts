import type { DataToObject, RetryConfig, S2RequestOptions } from "./common.js";
import { S2Error, withS2Data } from "./error.js";
import type { Client } from "./generated/client/types.gen.js";
import {
	type CreateStreamData,
	type CreateStreamResponse,
	createStream,
	type DeleteStreamData,
	deleteStream,
	type GetStreamConfigData,
	getStreamConfig,
	type ListStreamsData,
	type ListStreamsResponse,
	listStreams,
	type ReconfigureStreamData,
	type ReconfigureStreamResponse,
	reconfigureStream,
	type StreamConfig,
} from "./generated/index.js";
import { withRetries } from "./lib/retry.js";

export interface ListStreamsArgs extends DataToObject<ListStreamsData> {}
export interface CreateStreamArgs extends DataToObject<CreateStreamData> {}
export interface GetStreamConfigArgs
	extends DataToObject<GetStreamConfigData> {}
export interface DeleteStreamArgs extends DataToObject<DeleteStreamData> {}
export interface ReconfigureStreamArgs
	extends DataToObject<ReconfigureStreamData> {}

export class S2Streams {
	private readonly client: Client;
	private readonly retryConfig?: RetryConfig;

	constructor(client: Client, retryConfig?: RetryConfig) {
		this.client = client;
		this.retryConfig = retryConfig;
	}

	/**
	 * List streams in the basin.
	 *
	 * @param args.prefix Return streams whose names start with the given prefix
	 * @param args.start_after Name to start after (for pagination)
	 * @param args.limit Max results (up to 1000)
	 */
	public async list(
		args?: ListStreamsArgs,
		options?: S2RequestOptions,
	): Promise<ListStreamsResponse> {
		return await withRetries(this.retryConfig, async () => {
			return await withS2Data(() =>
				listStreams({
					client: this.client,
					query: args,
					...options,
				}),
			);
		});
	}

	/**
	 * Create a stream.
	 *
	 * @param args.stream Stream name (1-512 bytes, unique within the basin)
	 * @param args.config Stream configuration (retention, storage class, timestamping, delete-on-empty)
	 */
	public async create(
		args: CreateStreamArgs,
		options?: S2RequestOptions,
	): Promise<CreateStreamResponse> {
		return await withRetries(this.retryConfig, async () => {
			return await withS2Data(() =>
				createStream({
					client: this.client,
					body: args,
					...options,
				}),
			);
		});
	}

	/**
	 * Get stream configuration.
	 *
	 * @param args.stream Stream name
	 */
	public async getConfig(
		args: GetStreamConfigArgs,
		options?: S2RequestOptions,
	): Promise<StreamConfig> {
		return await withRetries(this.retryConfig, async () => {
			return await withS2Data(() =>
				getStreamConfig({
					client: this.client,
					path: args,
					...options,
				}),
			);
		});
	}

	/**
	 * Delete a stream.
	 *
	 * @param args.stream Stream name
	 */
	public async delete(
		args: DeleteStreamArgs,
		options?: S2RequestOptions,
	): Promise<void> {
		await withRetries(this.retryConfig, async () => {
			return await withS2Data(() =>
				deleteStream({
					client: this.client,
					path: args,
					...options,
				}),
			);
		});
	}

	/**
	 * Reconfigure a stream.
	 *
	 * @param args.stream Stream name
	 * @param args.body Configuration fields to change
	 */
	public async reconfigure(
		args: ReconfigureStreamArgs,
		options?: S2RequestOptions,
	): Promise<ReconfigureStreamResponse> {
		return await withRetries(this.retryConfig, async () => {
			return await withS2Data(() =>
				reconfigureStream({
					client: this.client,
					path: args,
					body: args,
					...options,
				}),
			);
		});
	}
}
