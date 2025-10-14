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
		args: AppendArgs,
		options?: S2RequestOptions,
	): Promise<AppendAck> {
		const hasBytes =
			args.records.some((record) => record.body instanceof Uint8Array) ||
			args.records.some((record) =>
				record.headers?.some(
					(header) =>
						header[0] instanceof Uint8Array || header[1] instanceof Uint8Array,
				),
			);

		const encodedRecords = args.records.map((record) => ({
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

type AppendRecord = Omit<GeneratedAppendRecord, "body" | "headers"> & {
	body?: string | Uint8Array;
	headers?: Array<[string | Uint8Array, string | Uint8Array]>;
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

class AppendSession
	extends WritableStream<AppendArgs>
	implements AsyncDisposable
{
	private _lastSeenPosition: AppendAck | undefined = undefined;
	private buffer: AppendArgs[] = [];
	private inFlight = false;
	private readonly options?: S2RequestOptions;
	private readonly stream: S2Stream;
	private acksController:
		| ReadableStreamDefaultController<AppendAck>
		| undefined;
	private _acksStream: AcksStream | undefined;
	private closed = false;

	static async create(stream: S2Stream, options?: S2RequestOptions) {
		return new AppendSession(stream, options);
	}

	private constructor(stream: S2Stream, options?: S2RequestOptions) {
		let writableController: WritableStreamDefaultController;
		super({
			start: (controller) => {
				writableController = controller;
			},
			write: async (chunk) => {
				await this.append(chunk);
			},
			close: async () => {
				this.closed = true;
				// Wait for any in-flight requests and buffer to drain
				await this.waitForDrain();
			},
			abort: async (reason) => {
				this.closed = true;
				this.buffer = [];
				// Clean up resources
			},
		});
		this.options = options;
		this.stream = stream;
	}

	[Symbol.asyncDispose]() {
		return this.abort(new S2Error({ message: "Abort" }));
	}

	acks(): AcksStream {
		if (!this._acksStream) {
			this._acksStream = new AcksStream((controller) => {
				this.acksController = controller;
			});
		}
		return this._acksStream;
	}

	async append(args: AppendArgs): Promise<void> {
		if (this.closed) {
			throw new S2Error({ message: "AppendSession is closed" });
		}

		// Add to buffer
		this.buffer.push(args);

		// Process buffer if nothing is in flight
		if (!this.inFlight) {
			await this.processBuffer();
		}
	}

	private async processBuffer(): Promise<void> {
		while (this.buffer.length > 0 && !this.closed) {
			this.inFlight = true;
			const args = this.buffer.shift()!;

			try {
				const ack = await this.stream.append(args, this.options);
				this._lastSeenPosition = ack;

				// Emit ack to the acks stream if it exists
				if (this.acksController) {
					this.acksController.enqueue(ack);
				}
			} catch (error) {
				this.inFlight = false;
				// Re-throw the error
				throw error;
			}

			this.inFlight = false;
		}
	}

	private async waitForDrain(): Promise<void> {
		// Wait until buffer is empty and nothing is in flight
		while (this.buffer.length > 0 || this.inFlight) {
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
