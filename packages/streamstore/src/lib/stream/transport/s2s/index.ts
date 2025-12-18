/**
 * S2S HTTP/2 transport for Node.js
 * Uses the s2s binary protocol over HTTP/2 for efficient streaming
 *
 * This file should only be imported in Node.js environments
 */

import type { ClientHttp2Session, ClientHttp2Stream } from "node:http2";
import createDebug from "debug";
import type { S2RequestOptions } from "../../../../common.js";
import {
	makeAppendPreconditionError,
	makeServerError,
	RangeNotSatisfiableError,
	S2Error,
} from "../../../../error.js";
import type { AppendAck, StreamPosition } from "../../../../generated/index.js";
import {
	AppendAck as ProtoAppendAck,
	ReadBatch as ProtoReadBatch,
	type StreamPosition as ProtoStreamPosition,
} from "../../../../generated/proto/s2.js";
import { meteredBytes } from "../../../../utils.js";
import * as Redacted from "../../../redacted.js";
import type { AppendResult, CloseResult } from "../../../result.js";
import { err, errClose, ok, okClose } from "../../../result.js";
import {
	RetryAppendSession as AppendSessionImpl,
	RetryReadSession as ReadSessionImpl,
} from "../../../retry.js";
import { DEFAULT_USER_AGENT } from "../../runtime.js";
import type {
	AppendArgs,
	AppendRecord,
	AppendSession,
	AppendSessionOptions,
	ReadArgs,
	ReadRecord,
	ReadResult,
	ReadSession,
	SessionTransport,
	TransportAppendSession,
	TransportConfig,
	TransportReadSession,
} from "../../types.js";
import { encodeProtoAppendInput } from "../proto.js";
import { frameMessage, S2SFrameParser } from "./framing.js";

const debug = createDebug("s2:s2s");

type Http2Module = typeof import("node:http2");

let http2ModulePromise: Promise<Http2Module> | undefined;
async function loadHttp2(): Promise<Http2Module> {
	// Hint bundlers to skip bundling node:http2 while keeping the specifier static for type inference.
	if (!http2ModulePromise) {
		http2ModulePromise = import(
			/* webpackIgnore: true */
			/* @vite-ignore */
			"node:http2"
		);
	}
	return http2ModulePromise;
}

export class S2STransport implements SessionTransport {
	private readonly transportConfig: TransportConfig;
	private connection?: ClientHttp2Session;
	private connectionPromise?: Promise<ClientHttp2Session>;
	private closingPromise?: Promise<void>;

	constructor(config: TransportConfig) {
		this.transportConfig = config;
	}

	async makeAppendSession(
		stream: string,
		sessionOptions?: AppendSessionOptions,
		requestOptions?: S2RequestOptions,
	): Promise<AppendSession> {
		return AppendSessionImpl.create(
			(myOptions) => {
				return S2SAppendSession.create(
					this.transportConfig.baseUrl,
					this.transportConfig.accessToken,
					stream,
					() => this.getConnection(),
					this.transportConfig.basinName,
					myOptions,
					requestOptions,
				);
			},
			sessionOptions,
			this.transportConfig.retry,
		);
	}

	async makeReadSession<Format extends "string" | "bytes" = "string">(
		stream: string,
		args?: ReadArgs<Format>,
		options?: S2RequestOptions,
	): Promise<ReadSession<Format>> {
		return ReadSessionImpl.create(
			(myArgs) => {
				return S2SReadSession.create(
					this.transportConfig.baseUrl,
					this.transportConfig.accessToken,
					stream,
					myArgs,
					options,
					() => this.getConnection(),
					this.transportConfig.basinName,
				);
			},
			args,
			this.transportConfig.retry,
		);
	}

	/**
	 * Get or create HTTP/2 connection (one per transport)
	 */
	private async getConnection(): Promise<ClientHttp2Session> {
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

	private async createConnection(): Promise<ClientHttp2Session> {
		const http2 = await loadHttp2();
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

	async close(): Promise<void> {
		if (this.closingPromise) {
			return this.closingPromise;
		}

		this.closingPromise = (async () => {
			const connection =
				this.connection ??
				(await this.connectionPromise?.catch(() => undefined));
			if (connection && !connection.closed && !connection.destroyed) {
				await new Promise<void>((resolve) => {
					connection.close(() => resolve());
				});
			}
			this.connection = undefined;
		})();

		try {
			await this.closingPromise;
		} finally {
			this.closingPromise = undefined;
		}
	}
}

class S2SReadSession<Format extends "string" | "bytes" = "string">
	extends ReadableStream<ReadResult<Format>>
	implements TransportReadSession<Format>
{
	private http2Stream?: ClientHttp2Stream;
	private _lastReadPosition?: StreamPosition;
	private _nextReadPosition?: StreamPosition;
	private _lastObservedTail?: StreamPosition;
	private parser = new S2SFrameParser();

	static async create<Format extends "string" | "bytes" = "string">(
		baseUrl: string,
		bearerToken: Redacted.Redacted,
		streamName: string,
		args: ReadArgs<Format> | undefined,
		options: S2RequestOptions | undefined,
		getConnection: () => Promise<ClientHttp2Session>,
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
		private getConnection: () => Promise<ClientHttp2Session>,
		private basinName?: string,
	) {
		// Initialize parser and textDecoder before super() call
		const parser = new S2SFrameParser();
		const textDecoder = new TextDecoder();
		let http2Stream: ClientHttp2Stream | undefined;
		let lastReadPosition: StreamPosition | undefined;

		// Track timeout for detecting when server stops sending data
		const TAIL_TIMEOUT_MS = 20000; // 20 seconds
		let timeoutTimer: NodeJS.Timeout | undefined;

		super({
			start: async (controller) => {
				let controllerClosed = false;
				let responseCode: number | undefined;
				const safeClose = () => {
					if (!controllerClosed) {
						controllerClosed = true;
						if (timeoutTimer) {
							clearTimeout(timeoutTimer);
							timeoutTimer = undefined;
						}
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
						if (timeoutTimer) {
							clearTimeout(timeoutTimer);
							timeoutTimer = undefined;
						}
						// Convert error to S2Error and enqueue as error result
						const s2Err =
							err instanceof S2Error
								? err
								: new S2Error({ message: String(err), status: 500 });
						controller.enqueue({ ok: false, error: s2Err });
						controller.close();
					}
				};

				// Helper to start/reset the timeout timer
				// Resets on every tail received, fires only if no tail for 20s
				const resetTimeoutTimer = () => {
					if (timeoutTimer) {
						clearTimeout(timeoutTimer);
					}
					timeoutTimer = setTimeout(() => {
						const timeoutError = new S2Error({
							message: `No tail received for ${TAIL_TIMEOUT_MS / 1000}s`,
							status: 408, // Request Timeout
							code: "TIMEOUT",
						});
						debug("tail timeout detected");
						safeError(timeoutError);
					}, TAIL_TIMEOUT_MS);
				};

				try {
					// Start the timeout timer - will fire in 20s if no tail received
					resetTimeoutTimer();
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
						"user-agent": DEFAULT_USER_AGENT,
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
						// Cache the status.
						// This informs whether we should attempt to parse s2s frames in the "data" handler.
						responseCode = headers[":status"] ?? 500;
					});

					connection.on("goaway", (errorCode, lastStreamID, opaqueData) => {
						debug("received GOAWAY from server");
					});

					stream.on("error", (err) => {
						safeError(err);
					});

					stream.on("data", (chunk: Buffer) => {
						try {
							if ((responseCode ?? 500) >= 400) {
								const errorText = textDecoder.decode(chunk);
								try {
									const errorJson = JSON.parse(errorText);
									safeError(
										new S2Error({
											message: errorJson.message ?? "Unknown error",
											code: errorJson.code,
											status: responseCode,
											origin: "server",
										}),
									);
								} catch {
									safeError(
										new S2Error({
											message: errorText || "Unknown error",
											status: responseCode,
											origin: "server",
										}),
									);
								}
								return;
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
											const status = frame.statusCode ?? 500;

											// Map known read errors
											if (status === 416) {
												safeError(new RangeNotSatisfiableError({ status }));
											} else {
												safeError(
													makeServerError(
														{ status, statusText: undefined },
														errorJson,
													),
												);
											}
										} catch {
											safeError(
												makeServerError(
													{
														status: frame.statusCode ?? 500,
														statusText: undefined,
													},
													errorText,
												),
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

										resetTimeoutTimer();

										// Update tail from batch
										if (protoBatch.tail) {
											const tail = convertStreamPosition(protoBatch.tail);
											lastReadPosition = tail;
											this._lastReadPosition = tail;
											this._lastObservedTail = tail;
											debug("received tail");
										}

										// Enqueue each record and track next position
										for (const record of protoBatch.records) {
											const converted = this.convertRecord(
												record,
												as ?? ("string" as Format),
												textDecoder,
											);
											controller.enqueue({ ok: true, value: converted });

											// Update next read position to after this record
											if (record.seqNum !== undefined) {
												this._nextReadPosition = {
													seq_num: Number(record.seqNum) + 1,
													timestamp: Number(record.timestamp ?? 0n),
												};
											}
										}
									} catch (err) {
										safeError(
											new S2Error({
												message: `Failed to parse ReadBatch: ${err}`,
												status: 500,
												origin: "sdk",
											}),
										);
									}
								}

								frame = parser.parseFrame();
							}
						} catch (error) {
							safeError(
								error instanceof S2Error
									? error
									: new S2Error({
											message: `Failed to process read data: ${error}`,
											status: 500,
											origin: "sdk",
										}),
							);
						}
					});

					stream.on("end", () => {
						if (stream.rstCode != 0) {
							debug("stream reset code=%d", stream.rstCode);
							safeError(
								new S2Error({
									message: `Stream ended with error: ${stream.rstCode}`,
									status: 500,
									code: "stream reset",
									origin: "sdk",
								}),
							);
						}
					});

					stream.on("close", () => {
						if (parser.hasData()) {
							safeError(
								new S2Error({
									message: "Stream closed with unparsed data remaining",
									status: 500,
									code: "STREAM_CLOSED_PREMATURELY",
									origin: "sdk",
								}),
							);
						} else {
							safeClose();
						}
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
			// Convert to string format with object headers
			const headerEntries = record.headers?.map(
				(h) =>
					[
						h.name ? textDecoder.decode(h.name) : "",
						h.value ? textDecoder.decode(h.value) : "",
					] as [string, string],
			);
			return {
				seq_num: Number(record.seqNum),
				timestamp: Number(record.timestamp),
				headers: headerEntries ? Object.fromEntries(headerEntries) : undefined,
				body: record.body ? textDecoder.decode(record.body) : undefined,
			} as ReadRecord<Format>;
		}
	}

	async [Symbol.asyncDispose]() {
		await this.cancel("disposed");
	}

	// Polyfill for older browsers / Node.js environments
	[Symbol.asyncIterator](): AsyncIterableIterator<ReadResult<Format>> {
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

	nextReadPosition(): StreamPosition | undefined {
		return this._nextReadPosition;
	}

	lastObservedTail(): StreamPosition | undefined {
		return this._lastObservedTail;
	}
}

/**
 * AcksStream for S2S append session
 */
// Removed S2SAcksStream - transport sessions no longer expose streams

/**
 * S2S-based transport session for appending records via HTTP/2.
 * Pipelined: multiple requests can be in-flight simultaneously.
 * No backpressure, no retry logic, no streams - just submit/close with value-encoded errors.
 */
class S2SAppendSession implements TransportAppendSession {
	private http2Stream?: ClientHttp2Stream;
	private parser = new S2SFrameParser();
	private closed = false;
	private pendingAcks: Array<{
		resolve: (result: AppendResult) => void;
		batchSize: number;
	}> = [];
	private initPromise?: Promise<void>;

	static async create(
		baseUrl: string,
		bearerToken: Redacted.Redacted,
		streamName: string,
		getConnection: () => Promise<ClientHttp2Session>,
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
		private getConnection: () => Promise<ClientHttp2Session>,
		private basinName?: string,
		sessionOptions?: AppendSessionOptions,
		private options?: S2RequestOptions,
	) {
		// No stream setup
		// Initialization happens lazily on first submit
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
			"user-agent": DEFAULT_USER_AGENT,
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

		const safeError = (error: unknown) => {
			const s2Err =
				error instanceof S2Error
					? error
					: new S2Error({ message: String(error), status: 502 });

			// Resolve all pending acks with error result
			for (const pending of this.pendingAcks) {
				pending.resolve(err(s2Err));
			}
			this.pendingAcks = [];
		};

		// Handle incoming data (acks)
		stream.on("data", (chunk: Buffer) => {
			try {
				this.parser.push(chunk);

				let frame = this.parser.parseFrame();
				while (frame) {
					if (frame.terminal) {
						if (frame.statusCode && frame.statusCode >= 400) {
							const errorText = textDecoder.decode(frame.body);
							const status = frame.statusCode ?? 500;
							try {
								const errorJson = JSON.parse(errorText);
								const err =
									status === 412
										? makeAppendPreconditionError(status, errorJson)
										: makeServerError(
												{ status, statusText: undefined },
												errorJson,
											);
								queueMicrotask(() => safeError(err));
							} catch {
								const err = makeServerError(
									{ status, statusText: undefined },
									errorText,
								);
								queueMicrotask(() => safeError(err));
							}
						}
						stream.close();
					} else {
						// Parse AppendAck
						try {
							const protoAck = ProtoAppendAck.fromBinary(frame.body);
							const ack = convertAppendAck(protoAck);

							// Resolve the pending ack promise (FIFO)
							const pending = this.pendingAcks.shift();
							if (pending) {
								pending.resolve(ok(ack));
							}
						} catch (parseErr) {
							queueMicrotask(() =>
								safeError(
									new S2Error({
										message: `Failed to parse AppendAck: ${parseErr}`,
										status: 500,
									}),
								),
							);
						}
					}

					frame = this.parser.parseFrame();
				}
			} catch (error) {
				queueMicrotask(() => safeError(error));
			}
		});

		stream.on("error", (streamErr: Error) => {
			queueMicrotask(() => safeError(streamErr));
		});

		stream.on("close", () => {
			// Stream closed - resolve any remaining pending acks with error
			// This can happen if the server closes the stream without sending all acks
			if (this.pendingAcks.length > 0) {
				queueMicrotask(() =>
					safeError(
						new S2Error({
							message: "Stream closed with pending acks",
							status: 502,
							code: "BAD_GATEWAY",
						}),
					),
				);
			}
		});
	}

	/**
	 * Send a batch and wait for ack. Returns AppendResult (never throws).
	 * Pipelined: multiple sends can be in-flight; acks resolve FIFO.
	 */
	private sendBatch(
		records: AppendRecord[],
		args: AppendArgs,
		batchMeteredSize: number,
	): Promise<AppendResult> {
		if (!this.http2Stream || this.http2Stream.closed) {
			return Promise.resolve(
				err(new S2Error({ message: "HTTP/2 stream is not open", status: 502 })),
			);
		}

		// Convert to protobuf AppendInput
		const bodyBytes = encodeProtoAppendInput(records, args);

		// Frame the message
		const frame = frameMessage({
			terminal: false,
			body: bodyBytes,
		});

		// Track pending ack - this promise resolves when the ack is received (FIFO)
		return new Promise((resolve) => {
			this.pendingAcks.push({
				resolve,
				batchSize: batchMeteredSize,
			});

			// Send the frame (pipelined - non-blocking)
			this.http2Stream!.write(frame, (writeErr) => {
				if (writeErr) {
					// Remove from pending acks on write error
					const idx = this.pendingAcks.findIndex((p) => p.resolve === resolve);
					if (idx !== -1) {
						this.pendingAcks.splice(idx, 1);
					}
					// Resolve with error result
					const s2Err =
						writeErr instanceof S2Error
							? writeErr
							: new S2Error({ message: String(writeErr), status: 502 });
					resolve(err(s2Err));
				}
				// Write completed successfully - promise resolves later when ack is received
			});
		});
	}

	/**
	 * Close the append session.
	 * Waits for all pending appends to complete before resolving.
	 * Never throws - returns CloseResult.
	 */
	async close(): Promise<CloseResult> {
		try {
			this.closed = true;

			// Wait for all pending acks to complete
			while (this.pendingAcks.length > 0) {
				await new Promise((resolve) => setTimeout(resolve, 10));
			}

			// Close the HTTP/2 stream (client doesn't send terminal frame for clean close)
			if (this.http2Stream && !this.http2Stream.closed) {
				this.http2Stream.end();
			}

			return okClose();
		} catch (error) {
			const s2Err =
				error instanceof S2Error
					? error
					: new S2Error({ message: String(error), status: 500 });
			return errClose(s2Err);
		}
	}

	/**
	 * Submit an append request to the session.
	 * Returns AppendResult (never throws).
	 * Pipelined: multiple submits can be in-flight; acks resolve FIFO.
	 */
	async submit(
		records: AppendRecord | AppendRecord[],
		args?: {
			fencingToken?: string;
			matchSeqNum?: number;
			precalculatedSize?: number;
		},
	): Promise<AppendResult> {
		// Validate closed state
		if (this.closed) {
			return err(
				new S2Error({ message: "AppendSession is closed", status: 400 }),
			);
		}

		// Lazy initialize HTTP/2 stream on first submit
		if (!this.initPromise) {
			this.initPromise = this.initializeStream();
		}

		try {
			await this.initPromise;
		} catch (initErr) {
			const s2Err =
				initErr instanceof S2Error
					? initErr
					: new S2Error({ message: String(initErr), status: 502 });
			return err(s2Err);
		}

		const recordsArray = Array.isArray(records) ? records : [records];

		// Validate batch size limits (non-retryable 400-level error)
		if (recordsArray.length > 1000) {
			return err(
				new S2Error({
					message: `Batch of ${recordsArray.length} exceeds maximum batch size of 1000 records`,
					status: 400,
					code: "INVALID_ARGUMENT",
				}),
			);
		}

		// Calculate metered size (use precalculated if provided)
		let batchMeteredSize = args?.precalculatedSize ?? 0;
		if (batchMeteredSize === 0) {
			for (const record of recordsArray) {
				batchMeteredSize += meteredBytes(record);
			}
		}

		if (batchMeteredSize > 1024 * 1024) {
			return err(
				new S2Error({
					message: `Batch size ${batchMeteredSize} bytes exceeds maximum of 1 MiB (1048576 bytes)`,
					status: 400,
					code: "INVALID_ARGUMENT",
				}),
			);
		}

		return this.sendBatch(
			recordsArray,
			{
				records: recordsArray,
				fencingToken: args?.fencingToken,
				matchSeqNum: args?.matchSeqNum,
			},
			batchMeteredSize,
		);
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
