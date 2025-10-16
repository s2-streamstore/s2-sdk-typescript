import type { S2RequestOptions } from "./common";
import { S2Error } from "./error";
import {
	type AppendAck,
	append,
	checkTail,
	type AppendInput as GeneratedAppendInput,
	type AppendRecord as GeneratedAppendRecord,
	type ReadBatch as GeneratedReadBatch,
	type SequencedRecord as GeneratedSequencedRecord,
	type ReadData,
	read,
	type StreamPosition,
} from "./generated";
import type { Client } from "./generated/client/types.gen";
import { EventStream } from "./lib/event-stream";

export class S2Stream {
	private readonly client: Client;

	public readonly name: string;

	constructor(name: string, client: Client) {
		this.name = name;
		this.client = client;
	}

	public async checkTail(options?: S2RequestOptions) {
		const response = await checkTail({
			client: this.client,
			path: {
				stream: this.name,
			},
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

	public async read<Format extends "string" | "bytes" = "string">(
		args?: ReadArgs<Format>,
		options?: S2RequestOptions,
	): Promise<ReadBatch<Format>> {
		const { as, ...queryParams } = args ?? {};
		const response = await read({
			client: this.client,
			path: {
				stream: this.name,
			},
			headers: {
				...(as === "bytes" ? { "s2-format": "base64" } : {}),
			},
			query: queryParams,
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
				throw new S2Error({
					message:
						"Range not satisfiable: requested position is beyond the stream tail. Use 'clamp: true' to start from the tail instead.",
					status: response.response.status,
					data: response.error,
				});
			}
		}

		if (args?.as === "bytes") {
			const res: ReadBatch<"bytes"> = {
				...response.data,
				records: response.data.records?.map((record) => ({
					...record,
					body: record.body ? Uint8Array.fromBase64(record.body) : undefined,
					headers: record.headers?.map(
						(header) =>
							header.map((h) => Uint8Array.fromBase64(h)) as [
								Uint8Array,
								Uint8Array,
							],
					),
				})),
			};
			return res as any; // not sure why this is necessary
		} else {
			const res: ReadBatch<"string"> = response.data;
			return res as any; // not sure why this is necessary
		}
	}
	public async append(
		records: AppendRecord | AppendRecord[],
		args?: Omit<AppendArgs, "records">,
		options?: S2RequestOptions,
	): Promise<AppendAck> {
		const recordsArray = Array.isArray(records) ? records : [records];
		const normalizeHeaders = (
			headers: AppendRecord["headers"],
		): [string | Uint8Array, string | Uint8Array][] | undefined => {
			if (headers === undefined) {
				return undefined;
			} else if (Array.isArray(headers)) {
				return headers;
			} else {
				return Object.entries(headers).map(([key, value]) => [key, value]);
			}
		};

		const recordsWithNormalizedHeaders = recordsArray.map((record) => ({
			...record,
			headers: normalizeHeaders(record.headers),
		}));

		const hasBytes =
			recordsWithNormalizedHeaders.some(
				(record) => record.body instanceof Uint8Array,
			) ||
			recordsWithNormalizedHeaders.some((record) =>
				record.headers?.some(
					(header) =>
						header[0] instanceof Uint8Array || header[1] instanceof Uint8Array,
				),
			);

		const encodedRecords = recordsWithNormalizedHeaders.map((record) => ({
			...record,
			body:
				record.body instanceof Uint8Array
					? record.body.toBase64()
					: hasBytes && record.body
						? new TextEncoder().encode(record.body).toBase64()
						: record.body,
			headers: record.headers?.map(
				(header) =>
					header.map((h) =>
						h instanceof Uint8Array
							? h.toBase64()
							: hasBytes
								? new TextEncoder().encode(h).toBase64()
								: h,
					) as [string, string],
			),
		}));

		const response = await append({
			client: this.client,
			path: {
				stream: this.name,
			},
			body: {
				...args,
				records: encodedRecords,
			},
			headers: {
				...(hasBytes ? { "s2-format": "base64" } : {}),
			},
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
				// special case for 412
				throw new S2Error({
					message: "Append condition failed",
					status: response.response.status,
					data: response.error,
				});
			}
		}
		return response.data;
	}
	public async readSession<Format extends "string" | "bytes" = "string">(
		args?: ReadArgs<Format>,
		options?: S2RequestOptions,
	): Promise<ReadSession<Format>> {
		return await ReadSession.create(this.client, this.name, args, options);
	}
	public async appendSession(
		options?: S2RequestOptions,
	): Promise<AppendSession> {
		return await AppendSession.create(this, options);
	}
}

type Header<Format extends "string" | "bytes" = "string"> =
	Format extends "string" ? [string, string] : [Uint8Array, Uint8Array];

type ReadBatch<Format extends "string" | "bytes" = "string"> = Omit<
	GeneratedReadBatch,
	"records"
> & {
	records?: Array<SequencedRecord<Format>>;
};

type SequencedRecord<Format extends "string" | "bytes" = "string"> = Omit<
	GeneratedSequencedRecord,
	"body" | "headers"
> & {
	body?: Format extends "string" ? string : Uint8Array;
	headers?: Array<Header<Format>>;
};

type ReadArgs<Format extends "string" | "bytes" = "string"> =
	ReadData["query"] & {
		as?: Format;
	};

export type AppendRecord = Omit<GeneratedAppendRecord, "body" | "headers"> & {
	body?: string | Uint8Array;
	headers?:
		| Array<[string | Uint8Array, string | Uint8Array]>
		| Record<string, string | Uint8Array>;
};

type AppendArgs = Omit<GeneratedAppendInput, "records"> & {
	records: Array<AppendRecord>;
};

class ReadSession<
	Format extends "string" | "bytes" = "string",
> extends EventStream<SequencedRecord<Format>> {
	static async create<Format extends "string" | "bytes" = "string">(
		client: Client,
		name: string,
		args?: ReadArgs<Format>,
		options?: S2RequestOptions,
	) {
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
				throw new S2Error({
					message:
						"Range not satisfiable: requested position is beyond the stream tail. Use 'clamp: true' to start from the tail instead.",
					status: response.response.status,
					data: response.error,
				});
			}
		}
		if (!response.response.body) {
			throw new S2Error({
				message: "No body in SSE response",
			});
		}
		return new ReadSession(response.response.body, args?.as ?? "string");
	}

	private _streamPosition: StreamPosition | undefined = undefined;

	private constructor(stream: ReadableStream<Uint8Array>, format: Format) {
		super(stream, (msg) => {
			// Parse SSE events according to the S2 protocol
			if (msg.event === "batch" && msg.data) {
				const batch: ReadBatch<Format> = JSON.parse(msg.data);
				// If format is bytes, decode base64 to Uint8Array
				if (format === "bytes") {
					for (const record of batch.records ?? []) {
						if (record.body && typeof record.body === "string") {
							(record as any).body = Uint8Array.fromBase64(record.body);
						}
						if (record.headers) {
							(record as any).headers = record.headers.map((header) =>
								header.map((h) =>
									typeof h === "string" ? Uint8Array.fromBase64(h) : h,
								),
							);
						}
					}
				}
				if (batch.tail) {
					this._streamPosition = batch.tail;
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

	public get streamPosition() {
		return this._streamPosition;
	}
}

class AcksStream extends ReadableStream<AppendAck> implements AsyncDisposable {
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

interface BatcherArgs {
	/** Duration in milliseconds to wait before flushing a batch (default: 5ms) */
	lingerDuration?: number;
	/** Maximum number of records in a batch (default: 1000) */
	maxBatchSize?: number;
	/** Optional fencing token to enforce (remains static across batches) */
	fencing_token?: string;
	/** Optional sequence number to match for first batch (auto-increments for subsequent batches) */
	match_seq_num?: number;
}

/**
 * Batches individual records and submits them to an AppendSession.
 * Handles linger duration, batch size limits, and auto-incrementing match_seq_num.
 */
class Batcher
	extends WritableStream<AppendRecord | AppendRecord[]>
	implements AsyncDisposable
{
	private session: AppendSession;
	private currentBatch: AppendRecord[] = [];
	private lingerTimer: ReturnType<typeof setTimeout> | null = null;
	private closed = false;
	private readonly maxBatchSize: number;
	private readonly lingerDuration: number;
	private readonly fencing_token?: string;
	private next_match_seq_num?: number;

	constructor(session: AppendSession, args?: BatcherArgs) {
		let writableController: WritableStreamDefaultController;

		super({
			start: (controller) => {
				writableController = controller;
			},
			write: (chunk) => {
				const records = Array.isArray(chunk) ? chunk : [chunk];
				this.submit(records);
			},
			close: () => {
				this.closed = true;
				this.flush();
				this.cleanup();
			},
			abort: (_reason) => {
				this.closed = true;
				this.currentBatch = [];
				this.cleanup();
			},
		});

		this.session = session;
		this.maxBatchSize = args?.maxBatchSize ?? 1000;
		this.lingerDuration = args?.lingerDuration ?? 5;
		this.fencing_token = args?.fencing_token;
		this.next_match_seq_num = args?.match_seq_num;
	}

	async [Symbol.asyncDispose]() {
		await this.close();
	}

	/**
	 * Submit one or more records to be batched.
	 */
	submit(records: AppendRecord | AppendRecord[]): void {
		if (this.closed) {
			throw new S2Error({ message: "Batcher is closed" });
		}

		let recordsArray = Array.isArray(records) ? records : [records];

		while (recordsArray.length > 0) {
			// Start linger timer on first record
			if (this.currentBatch.length === 0 && this.lingerDuration > 0) {
				this.startLingerTimer();
			}

			// Calculate how many records we can add to the current batch
			const availableSpace = this.maxBatchSize - this.currentBatch.length;
			const toAdd = recordsArray.slice(0, availableSpace);

			this.currentBatch.push(...toAdd);
			recordsArray = recordsArray.slice(availableSpace);

			// Flush if we've hit the batch size limit
			if (this.currentBatch.length >= this.maxBatchSize) {
				this.flush();
			}
		}
	}

	/**
	 * Flush the current batch to the session.
	 */
	flush(): void {
		this.cancelLingerTimer();

		if (this.currentBatch.length === 0) {
			return;
		}

		const args: AppendArgs = {
			records: this.currentBatch,
			fencing_token: this.fencing_token,
			match_seq_num: this.next_match_seq_num,
		};

		// Auto-increment match_seq_num for next batch
		if (this.next_match_seq_num !== undefined) {
			this.next_match_seq_num += this.currentBatch.length;
		}

		this.currentBatch = [];

		// Submit to session
		this.session.submit(args.records, {
			fencing_token: args.fencing_token,
			match_seq_num: args.match_seq_num,
		});
	}

	private startLingerTimer(): void {
		this.cancelLingerTimer();

		this.lingerTimer = setTimeout(() => {
			this.lingerTimer = null;
			if (!this.closed && this.currentBatch.length > 0) {
				this.flush();
			}
		}, this.lingerDuration);
	}

	private cancelLingerTimer(): void {
		if (this.lingerTimer) {
			clearTimeout(this.lingerTimer);
			this.lingerTimer = null;
		}
	}

	private cleanup(): void {
		this.cancelLingerTimer();
	}
}

/**
 * Session for appending records to a stream.
 * Queues append requests and ensures only one is in-flight at a time.
 */
class AppendSession
	extends WritableStream<AppendArgs>
	implements AsyncDisposable
{
	private _lastSeenPosition: AppendAck | undefined = undefined;
	private queue: AppendArgs[] = [];
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
		return new AppendSession(stream, options);
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
			abort: async (_reason) => {
				this.closed = true;
				this.queue = [];
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
		return new Batcher(this, args);
	}

	/**
	 * Get a stream of acknowledgements for appends.
	 */
	acks(): AcksStream {
		if (!this._acksStream) {
			this._acksStream = new AcksStream((controller) => {
				this.acksController = controller;
			});
		}
		return this._acksStream;
	}

	/**
	 * Submit an append request to the session.
	 * The request will be queued and sent when no other request is in-flight.
	 */
	submit(
		records: AppendArgs["records"],
		args?: Omit<AppendArgs, "records">,
	): void {
		if (this.closed) {
			throw new S2Error({ message: "AppendSession is closed" });
		}

		this.queue.push({ records, ...args });

		// Start processing if not already running
		if (!this.processingPromise) {
			this.processingPromise = this.processLoop();
		}
	}

	/**
	 * Main processing loop that sends queued requests one at a time.
	 */
	private async processLoop(): Promise<void> {
		while (!this.closed && this.queue.length > 0) {
			this.inFlight = true;
			const args = this.queue.shift()!;

			try {
				const ack = await this.stream.append(
					args.records,
					{
						fencing_token: args.fencing_token,
						match_seq_num: args.match_seq_num,
					},
					this.options,
				);
				this._lastSeenPosition = ack;

				// Emit ack to the acks stream if it exists
				if (this.acksController) {
					this.acksController.enqueue(ack);
				}
			} catch (error) {
				this.inFlight = false;
				this.processingPromise = null;
				// Re-throw the error
				throw error;
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

	get lastSeenPosition() {
		return this._lastSeenPosition;
	}
}
