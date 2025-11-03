/**
 * S2S HTTP/2 transport for Node.js
 * Uses the s2s binary protocol over HTTP/2 for efficient streaming
 *
 * This file should only be imported in Node.js environments
 */

import * as http2 from "node:http2";
import type { S2RequestOptions } from "../../../../common.js";
import {
	type Client,
	createClient,
	createConfig,
} from "../../../../generated/client/index.js";
import type { AppendAck, StreamPosition } from "../../../../generated/index.js";
import {
	AppendAck as ProtoAppendAck,
	AppendInput as ProtoAppendInput,
	ReadBatch as ProtoReadBatch,
	type StreamPosition as ProtoStreamPosition,
} from "../../../../generated/proto/s2.js";
import { S2Error } from "../../../../index.js";
import { meteredSizeBytes } from "../../../../utils.js";
import * as Redacted from "../../../redacted.js";
import type {
	AppendArgs,
	AppendRecord,
	AppendSession,
	AppendSessionOptions,
	ReadArgs,
	ReadRecord,
	ReadSession,
	SessionTransport,
	TransportConfig,
} from "../../types.js";
import { frameMessage, S2SFrameParser } from "./framing.js";

export function buildProtoAppendInput(
	records: AppendRecord[],
	args: AppendArgs,
): ProtoAppendInput {
	const textEncoder = new TextEncoder();
	return ProtoAppendInput.create({
		records: records.map((record) => {
			let headersArray:
				| Array<[string, string]>
				| Array<[Uint8Array, Uint8Array]>
				| undefined;
			if (record.headers) {
				if (Array.isArray(record.headers)) {
					headersArray = record.headers;
				} else {
					headersArray = Object.entries(record.headers);
				}
			}

			return {
				timestamp: record.timestamp ? BigInt(record.timestamp) : undefined,
				headers: headersArray?.map((h) => ({
					name: typeof h[0] === "string" ? textEncoder.encode(h[0]) : h[0],
					value: typeof h[1] === "string" ? textEncoder.encode(h[1]) : h[1],
				})),
				body:
					typeof record.body === "string"
						? textEncoder.encode(record.body)
						: record.body,
			};
		}),
		fencingToken: args.fencing_token ?? undefined,
		matchSeqNum:
			args.match_seq_num == null ? undefined : BigInt(args.match_seq_num),
	});
}

export class S2STransport implements SessionTransport {
	private readonly client: Client;
	private readonly transportConfig: TransportConfig;
	private connection?: http2.ClientHttp2Session;
	private connectionPromise?: Promise<http2.ClientHttp2Session>;

	constructor(config: TransportConfig) {
		this.client = createClient(
			createConfig({
				baseUrl: config.baseUrl,
				auth: () => Redacted.value(config.accessToken),
				headers: config.basinName ? { "s2-basin": config.basinName } : {},
			}),
		);
		this.transportConfig = config;
	}

	async makeAppendSession(
		stream: string,
		sessionOptions?: AppendSessionOptions,
		requestOptions?: S2RequestOptions,
	): Promise<AppendSession> {
		return S2SAppendSession.create(
			this.transportConfig.baseUrl,
			this.transportConfig.accessToken,
			stream,
			() => this.getConnection(),
			this.transportConfig.basinName,
			sessionOptions,
			requestOptions,
		);
	}

	async makeReadSession<Format extends "string" | "bytes" = "string">(
		stream: string,
		args?: ReadArgs<Format>,
		options?: S2RequestOptions,
	): Promise<ReadSession<Format>> {
		return S2SReadSession.create(
			this.transportConfig.baseUrl,
			this.transportConfig.accessToken,
			stream,
			args,
			options,
			() => this.getConnection(),
			this.transportConfig.basinName,
		);
	}

	/**
	 * Get or create HTTP/2 connection (one per transport)
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
		const url = new URL(this.transportConfig.baseUrl);
		const client = http2.connect(url.origin, {
			// Use HTTPS settings
			...(url.protocol === "https:"
				? {
						// TLS options can go here if needed
					}
				: {}),
			settings: {
				initialWindowSize: 10 * 1024 * 1024, // 10 MB
			},
		});

		return new Promise((resolve, reject) => {
			client.once("connect", () => {
				client.setLocalWindowSize(10 * 1024 * 1024);
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
		options: S2RequestOptions | undefined,
		getConnection: () => Promise<http2.ClientHttp2Session>,
		basinName?: string,
	): Promise<S2SReadSession<Format>> {
		const url = new URL(baseUrl);
		return new S2SReadSession(
			streamName,
			args,
			bearerToken,
			url,
			options,
			getConnection,
			basinName,
		);
	}

	private constructor(
		private streamName: string,
		private args: ReadArgs<Format> | undefined,
		private authToken: Redacted.Redacted,
		private url: URL,
		private options: S2RequestOptions | undefined,
		private getConnection: () => Promise<http2.ClientHttp2Session>,
		private basinName?: string,
	) {
		// Initialize parser and textDecoder before super() call
		const parser = new S2SFrameParser();
		const textDecoder = new TextDecoder();
		let http2Stream: http2.ClientHttp2Stream | undefined;
		let lastReadPosition: StreamPosition | undefined;

		super({
			start: async (controller) => {
				let controllerClosed = false;
				let responseCode: number | undefined;
				const safeClose = () => {
					if (!controllerClosed) {
						controllerClosed = true;
						try {
							controller.close();
						} catch {
							// Controller may already be closed, ignore
						}
					}
				};
				const safeError = (err: unknown) => {
					if (!controllerClosed) {
						controllerClosed = true;
						controller.error(err);
					}
				};

				try {
					const connection = await getConnection();

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

					const stream = connection.request({
						":method": "GET",
						":path": path,
						":scheme": url.protocol.slice(0, -1),
						":authority": url.host,
						authorization: `Bearer ${Redacted.value(authToken)}`,
						accept: "application/protobuf",
						"content-type": "s2s/proto",
						...(basinName ? { "s2-basin": basinName } : {}),
					});

					http2Stream = stream;

					options?.signal?.addEventListener("abort", () => {
						if (!stream.closed) {
							stream.close();
						}
					});

					stream.on("response", (headers) => {
						responseCode = headers[":status"] ?? 500;
					});

					stream.on("data", (chunk: Buffer) => {
						if ((responseCode ?? 500) >= 400) {
							const errorText = textDecoder.decode(chunk);
							try {
								const errorJson = JSON.parse(errorText);
								safeError(
									new S2Error({
										message: errorJson.message ?? "Unknown error",
										code: errorJson.code,
										status: responseCode,
									}),
								);
							} catch {
								safeError(
									new S2Error({
										message: errorText || "Unknown error",
										status: responseCode,
									}),
								);
							}
						}
						// Buffer already extends Uint8Array in Node.js, no need to convert
						parser.push(chunk);

						let frame = parser.parseFrame();
						while (frame) {
							if (frame.terminal) {
								if (frame.statusCode && frame.statusCode >= 400) {
									const errorText = textDecoder.decode(frame.body);
									try {
										const errorJson = JSON.parse(errorText);
										safeError(
											new S2Error({
												message: errorJson.message ?? "Unknown error",
												code: errorJson.code,
												status: frame.statusCode,
											}),
										);
									} catch {
										safeError(
											new S2Error({
												message: errorText || "Unknown error",
												status: frame.statusCode,
											}),
										);
									}
								} else {
									safeClose();
								}
								stream.close();
							} else {
								// Parse ReadBatch
								try {
									const protoBatch = ProtoReadBatch.fromBinary(frame.body);

									// Update position from tail
									if (protoBatch.tail) {
										lastReadPosition = convertStreamPosition(protoBatch.tail);
										// Assign to instance property
										this._lastReadPosition = lastReadPosition;
									}

									// Enqueue each record
									for (const record of protoBatch.records) {
										const converted = this.convertRecord(
											record,
											as ?? ("string" as Format),
											textDecoder,
										);
										controller.enqueue(converted);
									}
								} catch (err) {
									safeError(
										new S2Error({
											message: `Failed to parse ReadBatch: ${err}`,
										}),
									);
								}
							}

							frame = parser.parseFrame();
						}
					});

					stream.on("error", (err) => {
						safeError(err);
					});

					stream.on("close", () => {
						safeClose();
					});
				} catch (err) {
					safeError(err);
				}
			},
			cancel: async () => {
				if (http2Stream && !http2Stream.closed) {
					http2Stream.close();
				}
			},
		});

		// Assign parser to instance property after super() completes
		this.parser = parser;
		this.http2Stream = http2Stream;
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
		textDecoder: TextDecoder,
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
							h.name ? textDecoder.decode(h.name) : "",
							h.value ? textDecoder.decode(h.value) : "",
						] as [string, string],
				),
				body: record.body ? textDecoder.decode(record.body) : undefined,
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
 * AcksStream for S2S append session
 */
class S2SAcksStream
	extends ReadableStream<AppendAck>
	implements AsyncDisposable
{
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

	// Polyfill for older browsers
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
 * S2S Append Session for pipelined writes
 * Unlike fetch-based append, writes don't block on acks - only on submission
 */
class S2SAppendSession
	implements ReadableWritablePair<AppendAck, AppendArgs>, AsyncDisposable
{
	private http2Stream?: http2.ClientHttp2Stream;
	private _lastAckedPosition?: AppendAck;
	private parser = new S2SFrameParser();
	private acksController?: ReadableStreamDefaultController<AppendAck>;
	private _readable: S2SAcksStream;
	private _writable: WritableStream<AppendArgs>;
	private closed = false;
	private queuedBytes = 0;
	private readonly maxQueuedBytes: number;
	private waitingForCapacity: Array<() => void> = [];
	private pendingAcks: Array<{
		resolve: (ack: AppendAck) => void;
		reject: (error: any) => void;
		batchSize: number;
	}> = [];
	private initPromise?: Promise<void>;

	public readonly readable: ReadableStream<AppendAck>;
	public readonly writable: WritableStream<AppendArgs>;

	static async create(
		baseUrl: string,
		bearerToken: Redacted.Redacted,
		streamName: string,
		getConnection: () => Promise<http2.ClientHttp2Session>,
		basinName: string | undefined,
		sessionOptions?: AppendSessionOptions,
		requestOptions?: S2RequestOptions,
	): Promise<S2SAppendSession> {
		return new S2SAppendSession(
			baseUrl,
			bearerToken,
			streamName,
			getConnection,
			basinName,
			sessionOptions,
			requestOptions,
		);
	}

	private constructor(
		private baseUrl: string,
		private authToken: Redacted.Redacted,
		private streamName: string,
		private getConnection: () => Promise<http2.ClientHttp2Session>,
		private basinName?: string,
		sessionOptions?: AppendSessionOptions,
		private options?: S2RequestOptions,
	) {
		this.maxQueuedBytes = sessionOptions?.maxQueuedBytes ?? 10 * 1024 * 1024; // 10 MiB default

		// Create the readable stream for acks
		this._readable = new S2SAcksStream((controller) => {
			this.acksController = controller;
		});
		this.readable = this._readable;

		// Create the writable stream
		this._writable = new WritableStream<AppendArgs>({
			start: async (controller) => {
				this.initPromise = this.initializeStream();
				await this.initPromise;
			},
			write: async (chunk) => {
				if (this.closed) {
					throw new S2Error({ message: "AppendSession is closed" });
				}

				const recordsArray = Array.isArray(chunk.records)
					? chunk.records
					: [chunk.records];

				// Validate batch size limits
				if (recordsArray.length > 1000) {
					throw new S2Error({
						message: `Batch of ${recordsArray.length} exceeds maximum batch size of 1000 records`,
					});
				}

				// Calculate metered size
				let batchMeteredSize = 0;
				for (const record of recordsArray) {
					batchMeteredSize += meteredSizeBytes(record);
				}

				if (batchMeteredSize > 1024 * 1024) {
					throw new S2Error({
						message: `Batch size ${batchMeteredSize} bytes exceeds maximum of 1 MiB (1048576 bytes)`,
					});
				}

				// Wait for capacity if needed (backpressure)
				while (
					this.queuedBytes + batchMeteredSize > this.maxQueuedBytes &&
					!this.closed
				) {
					await new Promise<void>((resolve) => {
						this.waitingForCapacity.push(resolve);
					});
				}

				if (this.closed) {
					throw new S2Error({ message: "AppendSession is closed" });
				}

				// Send the batch immediately (pipelined)
				// Returns when frame is sent, not when ack is received
				await this.sendBatchNonBlocking(recordsArray, chunk, batchMeteredSize);
			},
			close: async () => {
				this.closed = true;
				await this.closeStream();
			},
			abort: async (reason) => {
				this.closed = true;
				this.queuedBytes = 0;

				// Reject all pending acks
				const error = new S2Error({
					message: `AppendSession was aborted: ${reason}`,
				});
				for (const pending of this.pendingAcks) {
					pending.reject(error);
				}
				this.pendingAcks = [];

				// Wake up all waiting for capacity
				for (const resolver of this.waitingForCapacity) {
					resolver();
				}
				this.waitingForCapacity = [];

				if (this.http2Stream && !this.http2Stream.closed) {
					this.http2Stream.close();
				}
			},
		});
		this.writable = this._writable;
	}

	private async initializeStream(): Promise<void> {
		const url = new URL(this.baseUrl);
		const connection = await this.getConnection();

		const path = `${url.pathname}/streams/${encodeURIComponent(this.streamName)}/records`;

		const stream = connection.request({
			":method": "POST",
			":path": path,
			":scheme": url.protocol.slice(0, -1),
			":authority": url.host,
			authorization: `Bearer ${Redacted.value(this.authToken)}`,
			"content-type": "s2s/proto",
			accept: "application/protobuf",
			...(this.basinName ? { "s2-basin": this.basinName } : {}),
		});

		this.http2Stream = stream;

		this.options?.signal?.addEventListener("abort", () => {
			if (!stream.closed) {
				stream.close();
			}
		});

		const textDecoder = new TextDecoder();
		let controllerClosed = false;

		const safeClose = () => {
			if (!controllerClosed && this.acksController) {
				controllerClosed = true;
				try {
					this.acksController.close();
				} catch {
					// Controller may already be closed, ignore
				}
			}
		};

		const safeError = (err: unknown) => {
			if (!controllerClosed && this.acksController) {
				controllerClosed = true;
				this.acksController.error(err);
			}

			// Reject all pending acks
			for (const pending of this.pendingAcks) {
				pending.reject(err);
			}
			this.pendingAcks = [];
		};

		// Handle incoming data (acks)
		stream.on("data", (chunk: Buffer) => {
			this.parser.push(chunk);

			let frame = this.parser.parseFrame();
			while (frame) {
				if (frame.terminal) {
					if (frame.statusCode && frame.statusCode >= 400) {
						const errorText = textDecoder.decode(frame.body);
						try {
							const errorJson = JSON.parse(errorText);
							safeError(
								new S2Error({
									message: errorJson.message ?? "Unknown error",
									code: errorJson.code,
									status: frame.statusCode,
								}),
							);
						} catch {
							safeError(
								new S2Error({
									message: errorText || "Unknown error",
									status: frame.statusCode,
								}),
							);
						}
					} else {
						safeClose();
					}
					stream.close();
				} else {
					// Parse AppendAck
					try {
						const protoAck = ProtoAppendAck.fromBinary(frame.body);

						const ack = convertAppendAck(protoAck);

						this._lastAckedPosition = ack;

						// Enqueue to readable stream
						if (this.acksController) {
							this.acksController.enqueue(ack);
						}

						// Resolve the pending ack promise
						const pending = this.pendingAcks.shift();
						if (pending) {
							pending.resolve(ack);

							// Release capacity
							this.queuedBytes -= pending.batchSize;

							// Wake up one waiting writer
							if (this.waitingForCapacity.length > 0) {
								const waiter = this.waitingForCapacity.shift()!;
								waiter();
							}
						}
					} catch (err) {
						safeError(
							new S2Error({
								message: `Failed to parse AppendAck: ${err}`,
							}),
						);
					}
				}

				frame = this.parser.parseFrame();
			}
		});

		stream.on("error", (err: Error) => {
			safeError(err);
		});

		stream.on("close", () => {
			safeClose();
		});
	}

	/**
	 * Send a batch non-blocking (returns when frame is sent, not when ack is received)
	 */
	private sendBatchNonBlocking(
		records: AppendRecord[],
		args: AppendArgs,
		batchMeteredSize: number,
	): Promise<void> {
		if (!this.http2Stream || this.http2Stream.closed) {
			return Promise.reject(
				new S2Error({ message: "HTTP/2 stream is not open" }),
			);
		}

		// Convert to protobuf AppendInput
		const protoInput = buildProtoAppendInput(records, args);

		const bodyBytes = ProtoAppendInput.toBinary(protoInput);

		// Frame the message
		const frame = frameMessage({
			terminal: false,
			body: bodyBytes,
		});

		// This promise resolves when the frame is written (not when ack is received)
		return new Promise<void>((resolve, reject) => {
			// Track pending ack - will be resolved when ack arrives
			const ackPromise = {
				resolve: () => {},
				reject,
				batchSize: batchMeteredSize,
			};
			this.pendingAcks.push(ackPromise);

			this.queuedBytes += batchMeteredSize;

			// Send the frame (pipelined)
			this.http2Stream!.write(frame, (err) => {
				if (err) {
					// Remove from pending acks on write error
					const idx = this.pendingAcks.indexOf(ackPromise);
					if (idx !== -1) {
						this.pendingAcks.splice(idx, 1);
						this.queuedBytes -= batchMeteredSize;
					}
					reject(err);
				} else {
					// Frame written successfully - resolve immediately (pipelined)
					resolve();
				}
			});
		});
	}

	/**
	 * Send a batch and wait for ack (used by submit method)
	 */
	private sendBatch(
		records: AppendRecord[],
		args: AppendArgs,
		batchMeteredSize: number,
	): Promise<AppendAck> {
		if (!this.http2Stream || this.http2Stream.closed) {
			return Promise.reject(
				new S2Error({ message: "HTTP/2 stream is not open" }),
			);
		}

		// Convert to protobuf AppendInput
		const protoInput = buildProtoAppendInput(records, args);

		const bodyBytes = ProtoAppendInput.toBinary(protoInput);

		// Frame the message
		const frame = frameMessage({
			terminal: false,
			body: bodyBytes,
		});

		// Track pending ack - this promise resolves when the ack is received
		return new Promise((resolve, reject) => {
			this.pendingAcks.push({
				resolve,
				reject,
				batchSize: batchMeteredSize,
			});

			this.queuedBytes += batchMeteredSize;

			// Send the frame (non-blocking - pipelined)
			this.http2Stream!.write(frame, (err) => {
				if (err) {
					// Remove from pending acks on write error
					const idx = this.pendingAcks.findIndex((p) => p.reject === reject);
					if (idx !== -1) {
						this.pendingAcks.splice(idx, 1);
						this.queuedBytes -= batchMeteredSize;
					}
					reject(err);
				}
				// Write completed, but promise resolves when ack is received
			});
		});
	}

	private async closeStream(): Promise<void> {
		// Wait for all pending acks
		while (this.pendingAcks.length > 0) {
			await new Promise((resolve) => setTimeout(resolve, 10));
		}

		// Close the HTTP/2 stream (client doesn't send terminal frame for clean close)
		if (this.http2Stream && !this.http2Stream.closed) {
			this.http2Stream.end();
		}
	}

	async [Symbol.asyncDispose]() {
		await this.close();
	}

	/**
	 * Get a stream of acknowledgements for appends.
	 */
	acks(): S2SAcksStream {
		return this._readable;
	}

	/**
	 * Close the append session.
	 * Waits for all pending appends to complete before resolving.
	 */
	async close(): Promise<void> {
		await this.writable.close();
	}

	/**
	 * Submit an append request to the session.
	 * Returns a promise that resolves with the ack when received.
	 */
	async submit(
		records: AppendRecord | AppendRecord[],
		args?: { fencing_token?: string; match_seq_num?: number },
	): Promise<AppendAck> {
		if (this.closed) {
			return Promise.reject(
				new S2Error({ message: "AppendSession is closed" }),
			);
		}

		// Wait for initialization
		if (this.initPromise) {
			await this.initPromise;
		}

		const recordsArray = Array.isArray(records) ? records : [records];

		// Validate batch size limits
		if (recordsArray.length > 1000) {
			return Promise.reject(
				new S2Error({
					message: `Batch of ${recordsArray.length} exceeds maximum batch size of 1000 records`,
				}),
			);
		}

		// Calculate metered size
		let batchMeteredSize = 0;
		for (const record of recordsArray) {
			batchMeteredSize += meteredSizeBytes(record);
		}

		if (batchMeteredSize > 1024 * 1024) {
			return Promise.reject(
				new S2Error({
					message: `Batch size ${batchMeteredSize} bytes exceeds maximum of 1 MiB (1048576 bytes)`,
				}),
			);
		}

		return this.sendBatch(
			recordsArray,
			{
				records: recordsArray,
				fencing_token: args?.fencing_token,
				match_seq_num: args?.match_seq_num,
			},
			batchMeteredSize,
		);
	}

	lastAckedPosition(): AppendAck | undefined {
		return this._lastAckedPosition;
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
function convertAppendAck(proto: ProtoAppendAck): AppendAck {
	if (!proto.start || !proto.end || !proto.tail) {
		throw new Error(
			"Invariant violation: AppendAck is missing required fields",
		);
	}
	return {
		start: convertStreamPosition(proto.start),
		end: convertStreamPosition(proto.end),
		tail: convertStreamPosition(proto.tail),
	};
}
