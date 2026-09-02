/**
 * S2S HTTP/2 transport for Node.js
 * Uses the s2s binary protocol over HTTP/2 for efficient streaming
 *
 * This file should only be imported in Node.js environments
 */

import type { OutgoingHttpHeaders } from "node:http";
import type { ClientHttp2Stream, Http2Session } from "node:http2";
import createDebug from "debug";

/** Type for ReadableStream with optional async iterator support. */
type ReadableStreamWithAsyncIterator<T> = ReadableStream<T> & {
	[Symbol.asyncIterator]?: () => AsyncIterableIterator<T>;
};

import type { S2RequestOptions } from "../../../../common.js";
import {
	isServerDraining,
	makeAppendPreconditionError,
	makeServerError,
	RangeNotSatisfiableError,
	reconnectAdvisedError,
	S2Error,
	s2Error,
} from "../../../../error.js";
import type * as API from "../../../../generated/index.js";
import * as Proto from "../../../../generated/proto/s2.js";
import { fromAPIStreamPosition } from "../../../../internal/mappers.js";
import type * as Types from "../../../../types.js";
import { S2_ENCRYPTION_KEY_HEADER } from "../../../encryption.js";
import { FifoQueue } from "../../../queue.js";
import { AdvisedReconnects } from "../../../reconnect.js";
import * as Redacted from "../../../redacted.js";
import type { AppendResult, CloseResult } from "../../../result.js";
import { err, errClose, ok, okClose } from "../../../result.js";
import {
	RetryAppendSession as AppendSessionImpl,
	RetryReadSession as ReadSessionImpl,
} from "../../../retry.js";
import { DEFAULT_USER_AGENT } from "../../runtime.js";
import type {
	AppendRecord,
	AppendSession,
	AppendSessionOptions,
	ReadArgs,
	ReadRecord,
	ReadSession,
	SessionTransport,
	TransportAppendSession,
	TransportConfig,
	TransportReadEvent,
	TransportReadSession,
} from "../../types.js";
import {
	bigintToSafeNumber,
	convertProtoRecord,
	encodeProtoAppendInput,
} from "../proto.js";
import {
	acceptEncodingHeader,
	assertCompressionSupported,
	compressFrameBody,
	decompressFrameBody,
} from "./compression.js";
import {
	type CompressionType,
	frameMessage,
	S2SFrameParser,
} from "./framing.js";
import { type PooledStream, sharedConnectionPool } from "./pool.js";

const debug = createDebug("s2:s2s");

const COMPRESSION_THRESHOLD_BYTES = 1024;

/** Query string for a read session request. */
export function readQueryString(args: ReadArgs<any> | undefined): string {
	const queryParams = new URLSearchParams();
	if (!args) return "";

	if (args.seq_num !== undefined)
		queryParams.set("seq_num", args.seq_num.toString());
	if (args.timestamp !== undefined)
		queryParams.set("timestamp", args.timestamp.toString());
	if (args.tail_offset !== undefined)
		queryParams.set("tail_offset", args.tail_offset.toString());
	if (args.clamp !== undefined) queryParams.set("clamp", String(args.clamp));
	if (args.count !== undefined) queryParams.set("count", args.count.toString());
	if (args.bytes !== undefined) queryParams.set("bytes", args.bytes.toString());
	if (args.wait !== undefined) queryParams.set("wait", args.wait.toString());
	if (typeof args.until === "number") {
		queryParams.set("until", args.until.toString());
	}
	return queryParams.toString();
}

/** Opens an HTTP/2 stream to the transport's endpoint. */
type OpenH2Stream = (headers: OutgoingHttpHeaders) => Promise<PooledStream>;

export class S2STransport implements SessionTransport {
	private readonly transportConfig: TransportConfig;
	private readonly compression: CompressionType;
	private readonly endpointOrigin: string;
	private attached = false;
	private closed = false;
	private closingPromise?: Promise<void>;

	constructor(config: TransportConfig) {
		this.transportConfig = config;
		this.compression = config.compression ?? "none";
		this.endpointOrigin = new URL(config.baseUrl).origin;
	}

	async makeAppendSession(
		stream: string,
		sessionOptions?: AppendSessionOptions,
		requestOptions?: S2RequestOptions,
	): Promise<AppendSession> {
		await assertCompressionSupported(this.compression);
		const advisedReconnects = new AdvisedReconnects();
		return AppendSessionImpl.create(
			(myOptions) => {
				return S2SAppendSession.create(
					this.transportConfig.baseUrl,
					this.transportConfig.accessToken,
					stream,
					(headers) => this.openH2Stream(headers),
					this.transportConfig.basinName,
					this.transportConfig.encryptionKey,
					this.compression,
					advisedReconnects,
					myOptions,
					requestOptions,
				);
			},
			sessionOptions,
			this.transportConfig.retry,
			stream, // Pass stream name for debug context
		);
	}

	async makeReadSession<Format extends "string" | "bytes" = "string">(
		stream: string,
		args?: ReadArgs<Format>,
		options?: S2RequestOptions,
	): Promise<ReadSession<Format>> {
		await assertCompressionSupported(this.compression);
		const advisedReconnects = new AdvisedReconnects();
		return ReadSessionImpl.create(
			(myArgs) => {
				return S2SReadSession.create(
					this.transportConfig.baseUrl,
					this.transportConfig.accessToken,
					stream,
					myArgs,
					options,
					(headers) => this.openH2Stream(headers),
					this.transportConfig.basinName,
					this.transportConfig.encryptionKey,
					this.compression,
					advisedReconnects,
				);
			},
			args,
			this.transportConfig.retry,
		);
	}

	/** Open an HTTP/2 stream through the shared connection pool. */
	private openH2Stream(headers: OutgoingHttpHeaders) {
		// Retries may fire after close(); re-attaching then would leak the pool entry.
		if (this.closed) {
			throw new S2Error({
				message: "S2STransport is closed",
				status: 400,
				origin: "sdk",
			});
		}
		if (!this.attached) {
			sharedConnectionPool.attach(
				this.endpointOrigin,
				this.transportConfig.http2,
			);
			this.attached = true;
		}
		return sharedConnectionPool.request(this.endpointOrigin, headers, {
			connectionTimeoutMillis: this.transportConfig.connectionTimeoutMillis,
			http2: this.transportConfig.http2,
		});
	}

	async close(): Promise<void> {
		this.closed = true;
		if (this.closingPromise) {
			return this.closingPromise;
		}

		this.closingPromise = (async () => {
			if (this.attached) {
				this.attached = false;
				await sharedConnectionPool.detach(
					this.endpointOrigin,
					this.transportConfig.http2,
				);
			}
		})();

		try {
			await this.closingPromise;
		} finally {
			this.closingPromise = undefined;
		}
	}
}

class S2SReadSession<Format extends "string" | "bytes" = "string">
	extends ReadableStream<TransportReadEvent<Format>>
	implements TransportReadSession<Format>
{
	private _lastObservedTail?: API.StreamPosition;

	static async create<Format extends "string" | "bytes" = "string">(
		baseUrl: string,
		bearerToken: Redacted.Redacted,
		streamName: string,
		args: ReadArgs<Format> | undefined,
		options: S2RequestOptions | undefined,
		openH2Stream: OpenH2Stream,
		basinName?: string,
		encryptionKey?: Redacted.Redacted<string>,
		compression: CompressionType = "none",
		advisedReconnects: AdvisedReconnects = new AdvisedReconnects(),
	): Promise<S2SReadSession<Format>> {
		const url = new URL(baseUrl);
		return new S2SReadSession(
			streamName,
			args,
			bearerToken,
			url,
			options,
			openH2Stream,
			basinName,
			encryptionKey,
			compression,
			advisedReconnects,
		);
	}

	private constructor(
		private streamName: string,
		private args: ReadArgs<Format> | undefined,
		private authToken: Redacted.Redacted,
		private url: URL,
		private options: S2RequestOptions | undefined,
		private openH2Stream: OpenH2Stream,
		private basinName?: string,
		private encryptionKey?: Redacted.Redacted<string>,
		private compression: CompressionType = "none",
		private advisedReconnects: AdvisedReconnects = new AdvisedReconnects(),
	) {
		const parser = new S2SFrameParser();
		const textDecoder = new TextDecoder();
		let http2Stream: ClientHttp2Stream | undefined;
		let controllerClosed = false;
		let cleanupListeners: (() => void) | undefined;
		// Track timeout for detecting when server stops sending data
		const TAIL_TIMEOUT_MS = 20000; // 20 seconds
		let timeoutTimer: NodeJS.Timeout | undefined;
		const markControllerClosed = () => {
			if (controllerClosed) return false;
			controllerClosed = true;
			cleanupListeners?.();
			cleanupListeners = undefined;
			if (timeoutTimer) {
				clearTimeout(timeoutTimer);
				timeoutTimer = undefined;
			}
			return true;
		};

		super({
			start: async (controller) => {
				let responseCode: number | undefined;
				let pendingChunks: Buffer[] | undefined;

				// Listener references for cleanup (issue #142)
				let abortHandler: (() => void) | undefined;
				let goawayHandler:
					| ((
							errorCode: number,
							lastStreamID: number,
							opaqueData: Buffer,
					  ) => void)
					| undefined;
				let sessionConnection: Http2Session | undefined;

				cleanupListeners = () => {
					if (abortHandler && options?.signal) {
						options.signal.removeEventListener("abort", abortHandler);
					}
					abortHandler = undefined;

					if (goawayHandler && sessionConnection) {
						sessionConnection.removeListener("goaway", goawayHandler);
					}
					goawayHandler = undefined;
					sessionConnection = undefined;
				};
				const safeClose = () => {
					if (markControllerClosed()) {
						try {
							controller.close();
						} catch {
							// Controller may already be closed, ignore
						}
					}
				};
				const safeError = (err: unknown) => {
					if (markControllerClosed()) {
						// Convert error to S2Error and enqueue as error result
						controller.enqueue({ ok: false, error: s2Error(err) });
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

					const { as } = args ?? {};
					const queryString = readQueryString(args);
					const path = `${url.pathname}/streams/${encodeURIComponent(streamName)}/records${queryString ? `?${queryString}` : ""}`;

					const acceptEncoding = await acceptEncodingHeader(compression);
					const { stream, poison } = await openH2Stream({
						":method": "GET",
						":path": path,
						":scheme": url.protocol.slice(0, -1),
						":authority": url.host,
						"user-agent": DEFAULT_USER_AGENT,
						authorization: `Bearer ${Redacted.value(authToken)}`,
						accept: "application/protobuf",
						"content-type": "s2s/proto",
						...(acceptEncoding ? { "accept-encoding": acceptEncoding } : {}),
						...(basinName ? { "s2-basin": basinName } : {}),
						...(encryptionKey
							? {
									[S2_ENCRYPTION_KEY_HEADER]: Redacted.value(encryptionKey),
								}
							: {}),
					});

					http2Stream = stream;
					let declinedAdvice = false;
					const handleServerError = (error: S2Error) => {
						if (isServerDraining(error)) {
							poison();
							this.advisedReconnects.record();
						}
						safeError(error);
					};
					if (controllerClosed) {
						stream.close();
						return;
					}

					abortHandler = () => {
						if (!stream.closed) {
							stream.close();
						}
					};
					options?.signal?.addEventListener("abort", abortHandler);

					stream.on("response", (headers) => {
						// Cache the status.
						// This informs whether we should attempt to parse s2s frames in the "data" handler.
						responseCode = headers[":status"] ?? 500;
						if (pendingChunks) {
							const buffered = pendingChunks;
							pendingChunks = undefined;
							for (const chunk of buffered) {
								processChunk(chunk);
							}
						}
					});

					sessionConnection = stream.session;
					goawayHandler = (errorCode, lastStreamID, opaqueData) => {
						debug("received GOAWAY from server");
					};
					sessionConnection?.on("goaway", goawayHandler);

					stream.on("error", (err) => {
						safeError(err);
					});

					const processChunk = (chunk: Buffer) => {
						if (controllerClosed) return;
						try {
							const status = responseCode ?? 500;
							if (status >= 400) {
								const errorText = textDecoder.decode(chunk);
								debug("error response: status=%d body=%s", status, errorText);
								if (status === 416) {
									try {
										const errorJson = JSON.parse(errorText);
										safeError(
											new RangeNotSatisfiableError({
												status,
												code: errorJson.code,
												tail: errorJson.tail
													? fromAPIStreamPosition(errorJson.tail)
													: undefined,
											}),
										);
									} catch {
										safeError(new RangeNotSatisfiableError({ status }));
									}
									return;
								}
								try {
									const errorJson = JSON.parse(errorText);
									handleServerError(
										new S2Error({
											message: errorJson.message ?? "Unknown error",
											code: errorJson.code,
											status,
											origin: "server",
										}),
									);
								} catch {
									handleServerError(
										new S2Error({
											message: errorText || "Unknown error",
											status,
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
												safeError(
													new RangeNotSatisfiableError({
														status,
														code: errorJson.code,
														tail: errorJson.tail
															? fromAPIStreamPosition(errorJson.tail)
															: undefined,
													}),
												);
											} else {
												handleServerError(
													makeServerError(
														{ status, statusText: undefined },
														errorJson,
													),
												);
											}
										} catch {
											handleServerError(
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
									try {
										const batchBytes =
											frame.compression === "none"
												? frame.body
												: decompressFrameBody(frame.body, frame.compression);
										const protoBatch = Proto.ReadBatch.fromBinary(batchBytes);

										resetTimeoutTimer();

										let tail: API.StreamPosition | undefined;
										if (protoBatch.tail) {
											tail = convertStreamPosition(protoBatch.tail);
											this._lastObservedTail = tail;
											debug("received tail");
										}

										const records = protoBatch.records.map((record) => {
											const converted = this.convertRecord(
												record,
												as ?? ("string" as Format),
												textDecoder,
											);

											return converted;
										});

										controller.enqueue({
											ok: true,
											batch: { records, ...(tail ? { tail } : {}) },
										});

										// Checked after delivery so the resume position already
										// accounts for this batch. Poisoning here rather than on
										// reconnect keeps the pool clean whatever the retry layer
										// goes on to do.
										if (frame.reconnectAdvised && !declinedAdvice) {
											poison();
											if (this.advisedReconnects.shouldReconnect()) {
												this.advisedReconnects.record();
												debug("reconnect advised, ending read session");
												safeError(reconnectAdvisedError());
												stream.close();
												return;
											}
											declinedAdvice = true;
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
					};

					stream.on("data", (chunk: Buffer) => {
						// Deno >= 2.7.5 emits "data" before "response";
						// buffer until the status is known so an error body isn't parsed as acks.
						if (responseCode === undefined) {
							(pendingChunks ??= []).push(chunk);
							return;
						}
						processChunk(chunk);
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
						if (pendingChunks || parser.hasData()) {
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
				markControllerClosed();
				if (http2Stream && !http2Stream.closed) {
					http2Stream.close();
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
		textDecoder: TextDecoder,
	): ReadRecord<Format> {
		return convertProtoRecord(record, format, textDecoder);
	}

	async [Symbol.asyncDispose]() {
		await this.cancel("disposed");
	}

	// Polyfill for older browsers / Node.js environments
	[Symbol.asyncIterator](): AsyncIterableIterator<TransportReadEvent<Format>> {
		const proto = ReadableStream.prototype as ReadableStreamWithAsyncIterator<
			TransportReadEvent<Format>
		>;
		const fn = proto[Symbol.asyncIterator];
		if (typeof fn === "function") {
			try {
				return fn.call(this);
			} catch {
				// Native method may throw "Illegal invocation" when called on subclass
				// Fall through to manual implementation
			}
		}
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
				try {
					await reader.cancel(e);
				} catch (err: any) {
					if (err?.code !== "ERR_INVALID_STATE") throw err;
				}
				reader.releaseLock();
				return { done: true, value: undefined };
			},
			return: async () => {
				try {
					await reader.cancel("done");
				} catch (err: any) {
					if (err?.code !== "ERR_INVALID_STATE") throw err;
				}
				reader.releaseLock();
				return { done: true, value: undefined };
			},
			[Symbol.asyncIterator]() {
				return this;
			},
		};
	}

	lastObservedTail(): API.StreamPosition | undefined {
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
	private pendingAcks = new FifoQueue<{
		resolve: (result: AppendResult) => void;
		batchSize: number;
	}>();
	private initPromise?: Promise<void>;
	private _effectSignalled = false;
	private abortHandler?: () => void;
	private reconnectAdvised = false;
	private reconnectDeclined = false;
	private terminalError?: S2Error;

	static async create(
		baseUrl: string,
		bearerToken: Redacted.Redacted,
		streamName: string,
		openH2Stream: OpenH2Stream,
		basinName: string | undefined,
		encryptionKey: Redacted.Redacted<string> | undefined,
		compression: CompressionType,
		advisedReconnects: AdvisedReconnects,
		sessionOptions?: AppendSessionOptions,
		requestOptions?: S2RequestOptions,
	): Promise<S2SAppendSession> {
		return new S2SAppendSession(
			baseUrl,
			bearerToken,
			streamName,
			openH2Stream,
			basinName,
			encryptionKey,
			compression,
			advisedReconnects,
			sessionOptions,
			requestOptions,
		);
	}

	private constructor(
		private baseUrl: string,
		private authToken: Redacted.Redacted,
		private streamName: string,
		private openH2Stream: OpenH2Stream,
		private basinName: string | undefined,
		private encryptionKey: Redacted.Redacted<string> | undefined,
		private compression: CompressionType,
		private advisedReconnects: AdvisedReconnects,
		sessionOptions?: AppendSessionOptions,
		private options?: S2RequestOptions,
	) {
		// No stream setup
		// Initialization happens lazily on first submit
	}

	private async initializeStream(): Promise<void> {
		const url = new URL(this.baseUrl);

		const path = `${url.pathname}/streams/${encodeURIComponent(this.streamName)}/records`;

		const acceptEncoding = await acceptEncodingHeader(this.compression);
		const { stream, poison } = await this.openH2Stream({
			":method": "POST",
			":path": path,
			":scheme": url.protocol.slice(0, -1),
			":authority": url.host,
			"user-agent": DEFAULT_USER_AGENT,
			authorization: `Bearer ${Redacted.value(this.authToken)}`,
			"content-type": "s2s/proto",
			accept: "application/protobuf",
			...(acceptEncoding ? { "accept-encoding": acceptEncoding } : {}),
			...(this.basinName ? { "s2-basin": this.basinName } : {}),
			...(this.encryptionKey
				? {
						[S2_ENCRYPTION_KEY_HEADER]: Redacted.value(this.encryptionKey),
					}
				: {}),
		});

		this.http2Stream = stream;

		// Store the handler so close() can remove it. A caller-provided signal
		// can outlive many sessions (RetryAppendSession recreates a session per
		// recovery, reusing the same signal), so an unremovable listener leaks.
		this.abortHandler = () => {
			if (!stream.closed) {
				stream.close();
			}
		};
		this.options?.signal?.addEventListener("abort", this.abortHandler);

		const textDecoder = new TextDecoder();
		let responseCode: number | undefined;
		let pendingChunks: Buffer[] | undefined;

		const safeError = (error: unknown) => {
			const normalized = s2Error(error);
			this.terminalError = normalized;
			// Resolve all pending acks with error result
			for (const pending of this.pendingAcks) {
				pending.resolve(err(normalized));
			}
			this.pendingAcks.clear();
			// Note: do NOT reset _effectSignalled here. Data may have been
			// written to the wire before the error occurred, so the flag
			// must stay true until the session is recreated.
		};
		const handleServerError = (error: S2Error) => {
			if (isServerDraining(error)) {
				poison();
				if (!this.reconnectAdvised || this.reconnectDeclined) {
					this.advisedReconnects.record();
				}
			}
			safeError(error);
		};

		// Capture HTTP response status
		stream.on("response", (headers) => {
			responseCode = headers[":status"] ?? 500;
			if (pendingChunks) {
				const buffered = pendingChunks;
				pendingChunks = undefined;
				for (const chunk of buffered) {
					processChunk(chunk);
				}
			}
		});

		// Handle incoming data (acks or error response)
		const processChunk = (chunk: Buffer) => {
			try {
				// Check for HTTP-level errors first (before s2s frame parsing)
				if ((responseCode ?? 200) >= 400) {
					const errorText = textDecoder.decode(chunk);
					try {
						const errorJson = JSON.parse(errorText);
						handleServerError(
							new S2Error({
								message: errorJson.message ?? "Unknown error",
								code: errorJson.code,
								status: responseCode,
								origin: "server",
							}),
						);
					} catch {
						handleServerError(
							new S2Error({
								message: errorText || "Unknown error",
								status: responseCode,
								origin: "server",
							}),
						);
					}
					return;
				}

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
								queueMicrotask(() => handleServerError(err));
							} catch {
								const err = makeServerError(
									{ status, statusText: undefined },
									errorText,
								);
								queueMicrotask(() => handleServerError(err));
							}
						}
						stream.close();
					} else {
						// The first advice poisons the pooled connection immediately,
						// so no new stream reuses a connection pinned to the draining
						// server, whatever this session goes on to do.
						if (frame.reconnectAdvised && !this.reconnectAdvised) {
							this.reconnectAdvised = true;
							poison();
							if (this.advisedReconnects.shouldReconnect()) {
								this.advisedReconnects.record();
								debug("reconnect advised, draining append session");
							} else {
								this.reconnectDeclined = true;
							}
						}
						// Parse AppendAck
						try {
							const ackBytes =
								frame.compression === "none"
									? frame.body
									: decompressFrameBody(frame.body, frame.compression);
							const protoAck = Proto.AppendAck.fromBinary(ackBytes);
							const ack = convertAppendAck(protoAck);

							// Resolve the pending ack promise (FIFO)
							const pending = this.pendingAcks.shift();
							if (pending) {
								pending.resolve(ok(ack));
							}
							// Reset effect signal when dormant (no pending acks)
							if (this.pendingAcks.length === 0) {
								this._effectSignalled = false;
								// Everything submitted was acknowledged; half-close so the
								// draining server can end the response cleanly.
								if (
									this.reconnectAdvised &&
									!this.reconnectDeclined &&
									!stream.writableEnded
								) {
									stream.end();
								}
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
		};

		stream.on("data", (chunk: Buffer) => {
			// Deno >= 2.7.5 emits "data" before "response";
			// buffer until the status is known so an error body isn't parsed as acks.
			if (responseCode === undefined) {
				(pendingChunks ??= []).push(chunk);
				return;
			}
			processChunk(chunk);
		});

		stream.on("error", (streamErr: Error) => {
			queueMicrotask(() => safeError(streamErr));
		});

		stream.on("close", () => {
			this.removeAbortListener();
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
	private async sendBatch(input: Types.AppendInput): Promise<AppendResult> {
		if (this.reconnectAdvised && !this.reconnectDeclined) {
			// Refuse the advised stream without writing, so the retry layer can
			// resubmit on a fresh session with no risk of duplication.
			return Promise.resolve(err(reconnectAdvisedError()));
		}
		if (this.terminalError) {
			return Promise.resolve(err(this.terminalError));
		}
		if (!this.http2Stream || this.http2Stream.closed) {
			return Promise.resolve(
				err(new S2Error({ message: "HTTP/2 stream is not open", status: 502 })),
			);
		}

		const protoBytes = encodeProtoAppendInput(input);
		const shouldCompress =
			this.compression !== "none" &&
			protoBytes.byteLength >= COMPRESSION_THRESHOLD_BYTES;
		const frameCompression: CompressionType = shouldCompress
			? this.compression
			: "none";
		const bodyBytes = shouldCompress
			? await compressFrameBody(protoBytes, this.compression)
			: protoBytes;

		const frame = frameMessage({
			terminal: false,
			compression: frameCompression,
			body: bodyBytes,
		});

		// Track pending ack - this promise resolves when the ack is received (FIFO)
		return new Promise((resolve) => {
			this.pendingAcks.push({
				resolve,
				batchSize: input.meteredBytes,
			});

			// Send the frame (pipelined - non-blocking)
			this._effectSignalled = true;
			this.http2Stream!.write(frame, (writeErr) => {
				if (writeErr) {
					// Remove from pending acks on write error
					this.pendingAcks.removeFirst((p) => p.resolve === resolve);
					// Note: do NOT reset _effectSignalled here. The write call
					// was attempted, so data may have partially entered the
					// kernel buffer before the error was reported.
					// Resolve with error result
					resolve(err(s2Error(writeErr)));
				}
				// Write completed successfully - promise resolves later when ack is received
			});
		});
	}

	/**
	 * Returns true if data may have been written to the HTTP/2 stream
	 * since the last time pendingAcks was empty (dormant).
	 */
	effectSignalled(): boolean {
		return this._effectSignalled;
	}

	/** Remove the abort listener from the caller-provided signal, if attached. */
	private removeAbortListener(): void {
		if (this.abortHandler && this.options?.signal) {
			this.options.signal.removeEventListener("abort", this.abortHandler);
		}
		this.abortHandler = undefined;
	}

	/**
	 * Close the append session.
	 * Waits for all pending appends to complete before resolving.
	 * Never throws - returns CloseResult.
	 */
	async close(): Promise<CloseResult> {
		try {
			this.closed = true;

			// Wait for any in-flight lazy initialization to finish. Otherwise a
			// concurrent initializeStream() can open and assign the HTTP/2 stream
			// after close() has already returned, orphaning it and permanently
			// holding a pool slot (activeStreams only decrements on stream close).
			// initPromise is only set by submit(), so if it's unset no stream was
			// ever opened and there is nothing to await.
			if (this.initPromise) {
				await this.initPromise.catch(() => {});
			}

			// Detach from the caller-provided signal (init has now run, so the
			// handler is registered if it ever will be).
			this.removeAbortListener();

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
			return errClose(s2Error(error));
		}
	}

	/**
	 * Submit an append request to the session.
	 * Returns AppendResult (never throws).
	 * Pipelined: multiple submits can be in-flight; acks resolve FIFO.
	 */
	async submit(input: Types.AppendInput): Promise<AppendResult> {
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
			return err(s2Error(initErr));
		}

		const recordsArray = Array.from(input.records);

		// Validate batch size limits (non-retryable 400-level error)
		// Note: This should already be validated by AppendInput.create(), but we check defensively
		if (recordsArray.length > 1000) {
			return err(
				new S2Error({
					message: `Batch of ${recordsArray.length} exceeds maximum batch size of 1000 records`,
					status: 400,
					code: "INVALID_ARGUMENT",
				}),
			);
		}

		if (input.meteredBytes > 1024 * 1024) {
			return err(
				new S2Error({
					message: `Batch size ${input.meteredBytes} bytes exceeds maximum of 1 MiB (1048576 bytes)`,
					status: 400,
					code: "INVALID_ARGUMENT",
				}),
			);
		}

		return this.sendBatch(input);
	}
}

/**
 * Convert protobuf StreamPosition to API StreamPosition (internal use)
 */
function convertStreamPosition(
	proto: Proto.StreamPosition,
): API.StreamPosition {
	return {
		seq_num: bigintToSafeNumber(proto.seqNum, "StreamPosition.seqNum"),
		timestamp: bigintToSafeNumber(proto.timestamp, "StreamPosition.timestamp"),
	};
}

/**
 * Convert API StreamPosition to SDK StreamPosition (public interface)
 */
function toSDKStreamPosition(pos: API.StreamPosition): Types.StreamPosition {
	return {
		seqNum: pos.seq_num,
		timestamp: new Date(pos.timestamp),
	};
}
function convertAppendAck(proto: Proto.AppendAck): Types.AppendAck {
	if (!proto.start || !proto.end || !proto.tail) {
		throw new Error(
			"Invariant violation: AppendAck is missing required fields",
		);
	}
	return {
		start: toSDKStreamPosition(convertStreamPosition(proto.start)),
		end: toSDKStreamPosition(convertStreamPosition(proto.end)),
		tail: toSDKStreamPosition(convertStreamPosition(proto.tail)),
	};
}
