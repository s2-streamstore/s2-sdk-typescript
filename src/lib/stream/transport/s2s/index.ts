/**
 * S2S HTTP/2 transport for Node.js
 * Uses the s2s binary protocol over HTTP/2 for efficient streaming
 *
 * This file should only be imported in Node.js environments
 */

import http2 from "node:http2";
import type { S2RequestOptions } from "../../../../common.js";
import {
	type Client,
	createClient,
	createConfig,
} from "../../../../generated/client/index.js";
import type { StreamPosition } from "../../../../generated/index.js";
import {
	ReadBatch as ProtoReadBatch,
	type StreamPosition as ProtoStreamPosition,
} from "../../../../generated/proto/s2/v1/s2.js";
import { S2Error } from "../../../../index.js";
import * as Redacted from "../../../redacted.js";
import type {
	AppendSession,
	AppendSessionOptions,
	ReadArgs,
	ReadRecord,
	ReadSession,
	SessionTransport,
	TransportConfig,
} from "../../types.js";
import { FetchAppendSession, FetchReadSession } from "../fetch/index.js";
import { S2SFrameParser } from "./framing.js";

export class S2STransport implements SessionTransport {
	private readonly client: Client;
	private readonly transportConfig: TransportConfig;
	constructor(config: TransportConfig) {
		this.client = createClient(
			createConfig({
				baseUrl: config.baseUrl,
				auth: () => Redacted.value(config.accessToken),
			}),
		);
		this.transportConfig = config;
	}

	async makeAppendSession(
		stream: string,
		sessionOptions?: AppendSessionOptions,
		requestOptions?: S2RequestOptions,
	): Promise<AppendSession> {
		return FetchAppendSession.create(
			stream,
			this.transportConfig,
			sessionOptions,
			requestOptions,
		);
	}

	async makeReadSession<Format extends "string" | "bytes" = "string">(
		stream: string,
		args?: ReadArgs<Format>,
		options?: S2RequestOptions,
	): Promise<ReadSession<Format>> {
		return FetchReadSession.create(this.client, stream, args, options);
	}
}

class S2SReadSession<Format extends "string" | "bytes" = "string">
	extends ReadableStream<ReadRecord<Format>>
	implements ReadSession<Format>
{
	private http2Stream?: http2.ClientHttp2Stream;
	private _lastReadPosition?: StreamPosition;
	private parser = new S2SFrameParser();

	static async create<Format extends "string" | "bytes" = "string">(
		baseUrl: string,
		bearerToken: Redacted.Redacted,
		streamName: string,
		args: ReadArgs<Format> | undefined,
	): Promise<S2SReadSession<Format>> {
		const url = new URL(baseUrl);
		const connection = await new Promise<http2.ClientHttp2Session>(
			(resolve, reject) => {
				const client = http2.connect(url.origin, {
					// Use HTTPS settings
					...(url.protocol === "https:"
						? {
								// TLS options can go here if needed
							}
						: {}),
				});
				client.once("connect", () => {
					resolve(client);
				});

				client.once("error", (err) => {
					reject(err);
				});
			},
		);
		return new S2SReadSession(streamName, args, connection, bearerToken, url);
	}

	private constructor(
		private streamName: string,
		private args: ReadArgs<Format> | undefined,
		private connection: http2.ClientHttp2Session,
		private authToken: Redacted.Redacted,
		private url: URL,
	) {
		let recordsController: ReadableStreamDefaultController<ReadRecord<Format>>;

		super({
			start: async (controller) => {
				recordsController = controller;

				try {
					// Build query string
					const queryParams = new URLSearchParams();
					const { as, ...readParams } = args ?? {};

					if (readParams.seq_num !== undefined)
						queryParams.set("seq_num", readParams.seq_num.toString());
					if (readParams.timestamp !== undefined)
						queryParams.set("timestamp", readParams.timestamp.toString());
					if (readParams.tail_offset !== undefined)
						queryParams.set("tail_offset", readParams.tail_offset.toString());
					if (readParams.count !== undefined)
						queryParams.set("count", readParams.count.toString());
					if (readParams.bytes !== undefined)
						queryParams.set("bytes", readParams.bytes.toString());
					if (readParams.wait !== undefined)
						queryParams.set("wait", readParams.wait.toString());
					if (typeof readParams.until === "number") {
						queryParams.set("until", readParams.until.toString());
					}

					const queryString = queryParams.toString();
					const path = `${url.pathname}/streams/${encodeURIComponent(streamName)}/records${queryString ? `?${queryString}` : ""}`;

					this.http2Stream = connection.request({
						":method": "GET",
						":path": path,
						":scheme": url.protocol.slice(0, -1),
						":authority": url.host,
						authorization: `Bearer ${Redacted.value(this.authToken)}`,
						accept: "application/protobuf",
						"content-type": "s2s/proto",
					});

					this.http2Stream.on("data", (chunk: Buffer) => {
						this.parser.push(new Uint8Array(chunk));

						let frame = this.parser.parseFrame();
						while (frame) {
							if (frame.terminal) {
								if (frame.statusCode && frame.statusCode >= 400) {
									const errorText = new TextDecoder().decode(frame.body);
									try {
										const errorJson = JSON.parse(errorText);
										controller.error(
											new S2Error({
												message: errorJson.message ?? "Unknown error",
												code: errorJson.code,
												status: frame.statusCode,
											}),
										);
									} catch {
										controller.error(
											new S2Error({
												message: errorText || "Unknown error",
												status: frame.statusCode,
											}),
										);
									}
								}
								controller.close();
								this.http2Stream?.close();
							} else {
								// Parse ReadBatch
								try {
									const protoBatch = ProtoReadBatch.fromBinary(frame.body);

									// Update position from tail
									if (protoBatch.tail) {
										this._lastReadPosition = convertStreamPosition(
											protoBatch.tail,
										);
									}

									// Enqueue each record
									for (const record of protoBatch.records) {
										const converted = this.convertRecord(
											record,
											as ?? ("string" as Format),
										);
										controller.enqueue(converted);
									}
								} catch (err) {
									controller.error(
										new S2Error({
											message: `Failed to parse ReadBatch: ${err}`,
										}),
									);
								}
							}

							frame = this.parser.parseFrame();
						}
					});

					this.http2Stream.on("error", (err) => {
						controller.error(err);
					});

					this.http2Stream.on("close", () => {
						controller.close();
					});
				} catch (err) {
					controller.error(err);
				}
			},
			cancel: async () => {
				if (this.http2Stream && !this.http2Stream.closed) {
					this.http2Stream.close();
				}
			},
		});
	}

	/**
	 * Convert a protobuf SequencedRecord to the requested format
	 */
	private convertRecord(
		record: {
			seqNum?: bigint;
			timestamp?: bigint;
			headers?: Array<{ name?: Uint8Array; value?: Uint8Array }>;
			body?: Uint8Array;
		},
		format: Format,
	): ReadRecord<Format> {
		if (format === "bytes") {
			return {
				seq_num: Number(record.seqNum),
				timestamp: Number(record.timestamp),
				headers: record.headers?.map(
					(h) =>
						[h.name ?? new Uint8Array(), h.value ?? new Uint8Array()] as [
							Uint8Array,
							Uint8Array,
						],
				),
				body: record.body,
			} as ReadRecord<Format>;
		} else {
			// Convert to string format
			return {
				seq_num: Number(record.seqNum),
				timestamp: Number(record.timestamp),
				headers: record.headers?.map(
					(h) =>
						[
							h.name ? new TextDecoder().decode(h.name) : "",
							h.value ? new TextDecoder().decode(h.value) : "",
						] as [string, string],
				),
				body: record.body ? new TextDecoder().decode(record.body) : undefined,
			} as ReadRecord<Format>;
		}
	}

	async [Symbol.asyncDispose]() {
		await this.cancel("disposed");
	}

	// Polyfill for older browsers / Node.js environments
	[Symbol.asyncIterator](): AsyncIterableIterator<ReadRecord<Format>> {
		const fn = (ReadableStream.prototype as any)[Symbol.asyncIterator];
		if (typeof fn === "function") return fn.call(this);
		const reader = this.getReader();
		return {
			next: async () => {
				const r = await reader.read();
				if (r.done) {
					reader.releaseLock();
					return { done: true, value: undefined };
				}
				return { done: false, value: r.value };
			},
			throw: async (e) => {
				await reader.cancel(e);
				reader.releaseLock();
				return { done: true, value: undefined };
			},
			return: async () => {
				await reader.cancel("done");
				reader.releaseLock();
				return { done: true, value: undefined };
			},
			[Symbol.asyncIterator]() {
				return this;
			},
		};
	}

	lastReadPosition(): StreamPosition | undefined {
		return this._lastReadPosition;
	}
}

/**
 * Convert protobuf StreamPosition to OpenAPI StreamPosition
 */
function convertStreamPosition(proto: ProtoStreamPosition): StreamPosition {
	return {
		seq_num: Number(proto.seqNum),
		timestamp: Number(proto.timestamp),
	};
}
