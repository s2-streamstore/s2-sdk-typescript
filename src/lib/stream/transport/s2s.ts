/**
 * S2S HTTP/2 transport for Node.js
 * Uses the s2s binary protocol over HTTP/2 for efficient streaming
 *
 * This file should only be imported in Node.js environments
 */

import type * as http2 from "node:http2";
import { S2Error } from "../../../error.js";
import {
	AppendInput,
	AppendAck as ProtoAppendAck,
	ReadBatch as ProtoReadBatch,
	type StreamPosition as ProtoStreamPosition,
} from "../../../generated/proto/s2.js";
import type {
	AppendAck,
	StreamPosition,
} from "../../../generated/types.gen.js";
import type { S2RequestOptions } from "../../common.js";
import * as Redacted from "../../redacted.js";
import { BatcherImpl } from "../batcher.js";
import type {
	AcksStream,
	AppendArgs,
	AppendRecord,
	AppendSession,
	Batcher,
	BatcherArgs,
	ReadArgs,
	ReadSession,
	SequencedRecord,
	SessionTransport,
	TransportConfig,
} from "../types.js";
import { frameMessage, S2SFrameParser } from "./s2s-framing.js";

/**
 * Convert protobuf StreamPosition to OpenAPI StreamPosition
 */
function convertStreamPosition(proto: ProtoStreamPosition): StreamPosition {
	return {
		seq_num: Number(proto.seqNum),
		timestamp: Number(proto.timestamp),
	};
}

/**
 * Convert protobuf AppendAck to OpenAPI AppendAck
 */
function convertAppendAck(proto: ProtoAppendAck): AppendAck {
	return {
		start: convertStreamPosition(proto.start!),
		end: convertStreamPosition(proto.end!),
		tail: convertStreamPosition(proto.tail!),
	};
}

/**
 * S2S Transport using HTTP/2 + binary protocol
 */
export class S2STransport implements SessionTransport {
	private baseUrl: string;
	private bearerToken: Redacted.Redacted;
	private connection?: http2.ClientHttp2Session;
	private connectionPromise?: Promise<http2.ClientHttp2Session>;

	constructor(config: TransportConfig) {
		this.baseUrl = config.baseUrl;
		this.bearerToken = config.accessToken;
	}

	async makeAppendSession(stream: string): Promise<AppendSession> {
		return S2SAppendSession.create(
			this.baseUrl,
			Redacted.value(this.bearerToken),
			stream,
			() => this.getConnection(),
		);
	}

	async makeReadSession<Format extends "string" | "bytes" = "string">(
		stream: string,
		args?: ReadArgs<Format>,
		options?: S2RequestOptions,
	): Promise<ReadSession<Format>> {
		return S2SReadSession.create(
			this.baseUrl,
			Redacted.value(this.bearerToken),
			stream,
			args,
			() => this.getConnection(),
		);
	}

	/**
	 * Get or create HTTP/2 connection (one per basin)
	 */
	private async getConnection(): Promise<http2.ClientHttp2Session> {
		if (
			this.connection &&
			!this.connection.closed &&
			!this.connection.destroyed
		) {
			return this.connection;
		}

		// If connection is in progress, wait for it
		if (this.connectionPromise) {
			return this.connectionPromise;
		}

		// Create new connection
		this.connectionPromise = this.createConnection();
		try {
			this.connection = await this.connectionPromise;
			return this.connection;
		} finally {
			this.connectionPromise = undefined;
		}
	}

	private async createConnection(): Promise<http2.ClientHttp2Session> {
		// Dynamic import for Node.js http2 module
		const http2 = await import("node:http2");

		const url = new URL(this.baseUrl);
		const client = http2.connect(url.origin, {
			// Use HTTPS settings
			...(url.protocol === "https:"
				? {
						// TLS options can go here if needed
					}
				: {}),
		});

		return new Promise((resolve, reject) => {
			client.once("connect", () => {
				resolve(client);
			});

			client.once("error", (err) => {
				reject(err);
			});

			// Handle connection close
			client.once("close", () => {
				if (this.connection === client) {
					this.connection = undefined;
				}
			});
		});
	}
}

/**
 * AcksStream implementation that extends ReadableStream and implements async iteration
 */
class AcksStreamImpl extends ReadableStream<AppendAck> implements AcksStream {
	constructor(
		setController: (
			controller: ReadableStreamDefaultController<AppendAck>,
		) => void,
	) {
		super({
			start: (controller) => {
				setController(controller);
			},
		});
	}

	async [Symbol.asyncDispose]() {
		await this.cancel("disposed");
	}

	// Polyfill for older browsers / Node.js environments
	[Symbol.asyncIterator](): AsyncIterableIterator<AppendAck> {
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
}

/**
 * S2S Append Session - bidirectional streaming over HTTP/2
 */
class S2SAppendSession
	extends WritableStream<AppendArgs>
	implements AppendSession
{
	private http2Stream?: http2.ClientHttp2Stream;
	private http2StreamPromise?: Promise<void>;
	private closed = false;
	private acksController?: ReadableStreamDefaultController<AppendAck>;
	private _acksStream: AcksStream | undefined;
	private parser = new S2SFrameParser();
	private _lastAckedPosition: AppendAck | undefined;
	private queue: AppendArgs[] = [];
	private pendingResolvers: Array<{
		resolve: (ack: AppendAck) => void;
		reject: (error: any) => void;
	}> = [];
	private processingPromise: Promise<void> | null = null;

	static async create(
		baseUrl: string,
		bearerToken: string,
		streamName: string,
		getConnection: () => Promise<http2.ClientHttp2Session>,
	): Promise<S2SAppendSession> {
		return new S2SAppendSession(
			baseUrl,
			bearerToken,
			streamName,
			getConnection,
		);
	}

	private constructor(
		private baseUrl: string,
		private bearerToken: string,
		private streamName: string,
		private getConnection: () => Promise<http2.ClientHttp2Session>,
	) {
		super({
			write: (chunk) => {
				this.submit(chunk.records, {
					fencing_token: chunk.fencing_token,
					match_seq_num: chunk.match_seq_num,
				});
			},
			close: async () => {
				await this.close();
			},
			abort: async (reason) => {
				this.closed = true;
				this.queue = [];

				// Reject all pending promises
				const error = new S2Error({
					message: `AppendSession was aborted: ${reason}`,
				});
				for (const resolver of this.pendingResolvers) {
					resolver.reject(error);
				}
				this.pendingResolvers = [];

				// Close the HTTP/2 stream
				if (this.http2Stream && !this.http2Stream.closed) {
					this.http2Stream.close();
				}
			},
		});
	}

	async [Symbol.asyncDispose]() {
		await this.close();
	}

	/**
	 * Ensure HTTP/2 stream is created and ready
	 */
	private async ensureHttp2Stream(): Promise<http2.ClientHttp2Stream> {
		if (
			this.http2Stream &&
			!this.http2Stream.closed &&
			!this.http2Stream.destroyed
		) {
			return this.http2Stream;
		}

		if (this.http2StreamPromise) {
			await this.http2StreamPromise;
			return this.http2Stream!;
		}

		this.http2StreamPromise = this.createHttp2Stream();
		await this.http2StreamPromise;
		return this.http2Stream!;
	}

	/**
	 * Create HTTP/2 stream for bidirectional append session
	 */
	private async createHttp2Stream(): Promise<void> {
		const connection = await this.getConnection();
		const url = new URL(this.baseUrl);

		this.http2Stream = connection.request({
			":method": "POST",
			":path": `${url.pathname}/streams/${encodeURIComponent(this.streamName)}/records`,
			":scheme": url.protocol.slice(0, -1),
			":authority": url.host,
			authorization: `Bearer ${this.bearerToken}`,
			"content-type": "s2s/proto",
			"accept-encoding": "identity",
		});

		// Set up response handling
		this.http2Stream.on("data", (chunk: Buffer) => {
			this.parser.push(new Uint8Array(chunk));

			let frame = this.parser.parseFrame();
			while (frame) {
				if (frame.terminal) {
					if (frame.statusCode && frame.statusCode >= 400) {
						const errorText = new TextDecoder().decode(frame.body);
						try {
							const errorJson = JSON.parse(errorText);
							this.acksController?.error(
								new S2Error({
									message: errorJson.message ?? "Unknown error",
									code: errorJson.code,
									status: frame.statusCode,
								}),
							);
						} catch {
							this.acksController?.error(
								new S2Error({
									message: errorText || "Unknown error",
									status: frame.statusCode,
								}),
							);
						}
					}
					this.acksController?.close();
					this.http2Stream?.close();
				} else {
					// Parse AppendAck
					try {
						const protoAck = ProtoAppendAck.fromBinary(frame.body);
						const ack = convertAppendAck(protoAck);
						this._lastAckedPosition = ack;
						this.acksController?.enqueue(ack);

						// Resolve pending promises in order (FIFO)
						if (this.pendingResolvers.length > 0) {
							const resolver = this.pendingResolvers.shift()!;
							resolver.resolve(ack);
						}
					} catch (err) {
						this.acksController?.error(
							new S2Error({
								message: `Failed to parse AppendAck: ${err}`,
							}),
						);
					}
				}

				frame = this.parser.parseFrame();
			}
		});

		this.http2Stream.on("error", (err) => {
			this.acksController?.error(err);

			// Reject all pending promises
			for (const resolver of this.pendingResolvers) {
				resolver.reject(err);
			}
			this.pendingResolvers = [];
		});

		this.http2Stream.on("close", () => {
			this.acksController?.close();
		});
	}

	/**
	 * Create a batcher that batches individual records and submits them to this session.
	 */
	makeBatcher(args?: BatcherArgs): Batcher {
		return new BatcherImpl(this, args);
	}

	/**
	 * Get a stream of acknowledgements for appends.
	 */
	acks(): AcksStream {
		if (!this._acksStream) {
			this._acksStream = new AcksStreamImpl((controller) => {
				this.acksController = controller;
			});
		}
		return this._acksStream;
	}

	/**
	 * Submit an append request to the session.
	 * The request will be queued and sent over the HTTP/2 stream.
	 * Returns a promise that resolves when the append is acknowledged.
	 */
	submit(
		records: AppendRecord | AppendRecord[],
		args?: Omit<AppendArgs, "records">,
	): Promise<AppendAck> {
		if (this.closed) {
			return Promise.reject(
				new S2Error({ message: "AppendSession is closed" }),
			);
		}

		return new Promise((resolve, reject) => {
			this.queue.push({
				records: Array.isArray(records) ? records : [records],
				...args,
			});
			this.pendingResolvers.push({ resolve, reject });

			// Start processing if not already running
			if (!this.processingPromise) {
				this.processingPromise = this.processLoop();
			}
		});
	}

	/**
	 * Main processing loop that sends queued requests over the HTTP/2 stream.
	 */
	private async processLoop(): Promise<void> {
		// Ensure stream is created
		try {
			await this.ensureHttp2Stream();
		} catch (err) {
			// Reject all pending promises if stream creation fails
			for (const resolver of this.pendingResolvers) {
				resolver.reject(err);
			}
			this.pendingResolvers = [];
			this.queue = [];
			this.processingPromise = null;
			return;
		}

		while (!this.closed && this.queue.length > 0) {
			const appendArgs = this.queue.shift()!;
			const resolver = this.pendingResolvers.shift()!;

			try {
				// Convert AppendArgs to protobuf AppendInput
				const appendInput = this.convertToProto(appendArgs);
				const bodyBytes = AppendInput.toBinary(appendInput);

				// Frame the message
				const frame = frameMessage({
					terminal: false,
					compression: "none",
					body: bodyBytes,
				});

				// Write to HTTP/2 stream
				await new Promise<void>((resolve, reject) => {
					this.http2Stream!.write(frame, (err) => {
						if (err) reject(err);
						else resolve();
					});
				});

				// Resolve will happen when we receive the ack in the data handler
				// Store resolver to match with ack (for now we assume order preservation)
				// This is simplified - in a real implementation we'd need request IDs
			} catch (error) {
				resolver.reject(error);

				// On error, reject all remaining promises
				for (const pendingResolver of this.pendingResolvers) {
					pendingResolver.reject(error);
				}
				this.pendingResolvers = [];
				this.queue = [];
				this.processingPromise = null;
				return;
			}
		}

		this.processingPromise = null;
	}

	/**
	 * Convert AppendArgs to protobuf AppendInput
	 */
	private convertToProto(args: AppendArgs): {
		records: Array<{
			headers: Array<{ name: Uint8Array; value: Uint8Array }>;
			body: Uint8Array;
			timestamp?: bigint;
		}>;
		fencingToken?: string;
		matchSeqNum?: bigint;
	} {
		return {
			records: args.records.map((record) => {
				// Convert headers
				let headers: Array<{ name: Uint8Array; value: Uint8Array }> = [];
				if (record.headers) {
					if (Array.isArray(record.headers)) {
						headers = record.headers.map(([name, value]) => ({
							name:
								typeof name === "string"
									? new TextEncoder().encode(name)
									: name,
							value:
								typeof value === "string"
									? new TextEncoder().encode(value)
									: value,
						}));
					} else {
						// Record<string, string | Uint8Array>
						headers = Object.entries(record.headers).map(([name, value]) => ({
							name: new TextEncoder().encode(name),
							value:
								typeof value === "string"
									? new TextEncoder().encode(value)
									: value,
						}));
					}
				}

				// Convert body
				const body =
					record.body === undefined
						? new Uint8Array()
						: typeof record.body === "string"
							? new TextEncoder().encode(record.body)
							: record.body;

				return {
					headers,
					body,
					timestamp:
						record.timestamp !== undefined && record.timestamp !== null
							? BigInt(record.timestamp)
							: undefined,
				};
			}),
			fencingToken:
				args.fencing_token !== undefined && args.fencing_token !== null
					? args.fencing_token
					: undefined,
			matchSeqNum:
				args.match_seq_num !== undefined && args.match_seq_num !== null
					? BigInt(args.match_seq_num)
					: undefined,
		};
	}

	lastAckedPosition(): AppendAck | undefined {
		return this._lastAckedPosition;
	}

	async close(): Promise<void> {
		this.closed = true;

		// Wait for processing to complete
		if (this.processingPromise) {
			await this.processingPromise;
		}

		// Wait until queue is empty
		while (this.queue.length > 0) {
			await new Promise((resolve) => setTimeout(resolve, 10));
		}

		// Send terminal frame
		if (this.http2Stream && !this.http2Stream.closed) {
			const frame = frameMessage({
				terminal: true,
				compression: "none",
				body: new Uint8Array(0),
			});
			this.http2Stream.write(frame);
			this.http2Stream.end();
		}

		// Close the acks stream
		if (this.acksController) {
			this.acksController.close();
		}
	}
}

/**
 * S2S Read Session - unidirectional streaming from server
 */
class S2SReadSession<Format extends "string" | "bytes" = "string">
	extends ReadableStream<SequencedRecord<Format>>
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
		getConnection: () => Promise<http2.ClientHttp2Session>,
	): Promise<S2SReadSession<Format>> {
		return new S2SReadSession(
			baseUrl,
			bearerToken,
			streamName,
			args,
			getConnection,
		);
	}

	private constructor(
		private baseUrl: string,
		private bearerToken: Redacted.Redacted,
		private streamName: string,
		private args: ReadArgs<Format> | undefined,
		private getConnection: () => Promise<http2.ClientHttp2Session>,
	) {
		let recordsController: ReadableStreamDefaultController<
			SequencedRecord<Format>
		>;

		super({
			start: async (controller) => {
				recordsController = controller;

				try {
					const connection = await getConnection();
					const url = new URL(baseUrl);

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
						authorization: `Bearer ${Redacted.value(bearerToken)}`,
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
	): SequencedRecord<Format> {
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
			} as SequencedRecord<Format>;
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
			} as SequencedRecord<Format>;
		}
	}

	async [Symbol.asyncDispose]() {
		await this.cancel("disposed");
	}

	// Polyfill for older browsers / Node.js environments
	[Symbol.asyncIterator](): AsyncIterableIterator<SequencedRecord<Format>> {
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
