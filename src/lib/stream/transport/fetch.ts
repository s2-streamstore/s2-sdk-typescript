import { RangeNotSatisfiableError, S2Error } from "../../../error.js";
import {
	type Client,
	createClient,
	createConfig,
} from "../../../generated/client/index.js";
import {
	type AppendAck,
	read,
	type StreamPosition,
} from "../../../generated/index.js";
import { S2Stream } from "../../../stream.js";
import { decodeFromBase64, encodeToBase64 } from "../../base64.js";
import type { S2RequestOptions } from "../../common.js";
import { EventStream } from "../../event-stream.js";
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
	ReadBatch,
	ReadSession,
	SequencedRecord,
	SessionTransport,
	TransportConfig,
} from "../types.js";

export class FetchReadSession<Format extends "string" | "bytes" = "string">
	extends EventStream<SequencedRecord<Format>>
	implements ReadSession<Format>
{
	static async create<Format extends "string" | "bytes" = "string">(
		client: Client,
		name: string,
		args?: ReadArgs<Format>,
		options?: S2RequestOptions,
	): Promise<FetchReadSession<Format>> {
		const { as, ...queryParams } = args ?? {};
		const response = await read({
			client,
			path: {
				stream: name,
			},
			headers: {
				accept: "text/event-stream",
				...(as === "bytes" ? { "s2-format": "base64" } : {}),
			},
			query: queryParams,
			parseAs: "stream",
			...options,
		});
		if (response.error) {
			if ("message" in response.error) {
				throw new S2Error({
					message: response.error.message,
					code: response.error.code ?? undefined,
					status: response.response.status,
				});
			} else {
				// special case for 416 - Range Not Satisfiable
				throw new RangeNotSatisfiableError({
					status: response.response.status,
				});
			}
		}
		if (!response.response.body) {
			throw new S2Error({
				message: "No body in SSE response",
			});
		}
		return new FetchReadSession(response.response.body, args?.as ?? "string");
	}

	private _lastReadPosition: StreamPosition | undefined = undefined;

	private constructor(stream: ReadableStream<Uint8Array>, format: Format) {
		super(stream, (msg) => {
			// Parse SSE events according to the S2 protocol
			if (msg.event === "batch" && msg.data) {
				const batch: ReadBatch<Format> = JSON.parse(msg.data);
				// If format is bytes, decode base64 to Uint8Array
				if (format === "bytes") {
					for (const record of batch.records ?? []) {
						if (record.body && typeof record.body === "string") {
							(record as any).body = decodeFromBase64(record.body);
						}
						if (record.headers) {
							(record as any).headers = record.headers.map((header) =>
								header.map((h) =>
									typeof h === "string" ? decodeFromBase64(h) : h,
								),
							);
						}
					}
				}
				if (batch.tail) {
					this._lastReadPosition = batch.tail;
				}
				return { done: false, batch: true, value: batch.records ?? [] };
			}
			if (msg.event === "error") {
				// Handle error events
				throw new S2Error({ message: msg.data ?? "Unknown error" });
			}

			// Skip ping events and other events
			return { done: false };
		});
	}

	public lastReadPosition() {
		return this._lastReadPosition;
	}
}

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
 * Session for appending records to a stream.
 * Queues append requests and ensures only one is in-flight at a time.
 */
export class FetchAppendSession
	extends WritableStream<AppendArgs>
	implements AppendSession
{
	private _lastAckedPosition: AppendAck | undefined = undefined;
	private queue: AppendArgs[] = [];
	private pendingResolvers: Array<{
		resolve: (ack: AppendAck) => void;
		reject: (error: any) => void;
	}> = [];
	private inFlight = false;
	private readonly options?: S2RequestOptions;
	private readonly stream: S2Stream;
	private acksController:
		| ReadableStreamDefaultController<AppendAck>
		| undefined;
	private _acksStream: AcksStream | undefined;
	private closed = false;
	private processingPromise: Promise<void> | null = null;

	static async create(stream: S2Stream, options?: S2RequestOptions) {
		return new FetchAppendSession(stream, options);
	}

	private constructor(stream: S2Stream, options?: S2RequestOptions) {
		let writableController: WritableStreamDefaultController;

		super({
			start: (controller) => {
				writableController = controller;
			},
			write: (chunk) => {
				this.submit(chunk.records, {
					fencing_token: chunk.fencing_token,
					match_seq_num: chunk.match_seq_num,
				});
			},
			close: async () => {
				this.closed = true;
				await this.waitForDrain();
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
			},
		});
		this.options = options;
		this.stream = stream;
	}

	async [Symbol.asyncDispose]() {
		await this.close();
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
	 * The request will be queued and sent when no other request is in-flight.
	 * Returns a promise that resolves when the append is acknowledged or rejects on error.
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
	 * Main processing loop that sends queued requests one at a time.
	 */
	private async processLoop(): Promise<void> {
		while (!this.closed && this.queue.length > 0) {
			this.inFlight = true;
			const args = this.queue.shift()!;
			const resolver = this.pendingResolvers.shift()!;

			try {
				const ack = await this.stream.append(
					args.records,
					{
						fencing_token: args.fencing_token,
						match_seq_num: args.match_seq_num,
					},
					this.options,
				);
				this._lastAckedPosition = ack;

				// Emit ack to the acks stream if it exists
				if (this.acksController) {
					this.acksController.enqueue(ack);
				}

				// Resolve the promise for this request
				resolver.resolve(ack);
			} catch (error) {
				this.inFlight = false;
				this.processingPromise = null;

				// Reject the promise for this request
				resolver.reject(error);

				// Reject all remaining pending promises
				for (const pendingResolver of this.pendingResolvers) {
					pendingResolver.reject(error);
				}
				this.pendingResolvers = [];

				// Clear the queue
				this.queue = [];

				// Do not rethrow here to avoid unhandled rejection; callers already received rejection
			}

			this.inFlight = false;
		}

		this.processingPromise = null;
	}

	private async waitForDrain(): Promise<void> {
		// Wait for processing to complete
		if (this.processingPromise) {
			await this.processingPromise;
		}

		// Wait until queue is empty and nothing is in flight
		while (this.queue.length > 0 || this.inFlight) {
			await new Promise((resolve) => setTimeout(resolve, 10));
		}

		// Close the acks stream if it exists
		if (this.acksController) {
			this.acksController.close();
		}
	}

	lastAckedPosition(): AppendAck | undefined {
		return this._lastAckedPosition;
	}
}

/**
 * Fetch-based transport using HTTP/1.1 + JSON
 * Works in all JavaScript environments (browser, Node.js, Deno, etc.)
 */
export class FetchTransport implements SessionTransport {
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

	async makeAppendSession(stream: string): Promise<AppendSession> {
		const s2Stream = new S2Stream(stream, this.client, this.transportConfig);
		return FetchAppendSession.create(s2Stream);
	}

	async makeReadSession<Format extends "string" | "bytes" = "string">(
		stream: string,
		args?: ReadArgs<Format>,
		options?: S2RequestOptions,
	): Promise<ReadSession<Format>> {
		return FetchReadSession.create(this.client, stream, args, options);
	}
}
