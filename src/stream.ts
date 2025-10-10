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
	type ReadEvent,
	read,
} from "./generated";
import type { Client } from "./generated/client/types.gen";

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
		const response = await read({
			client: this.client,
			path: {
				stream: this.name,
			},
			headers: {
				...(args?.as === "bytes" ? { "s2-format": "base64" } : {}),
			},
			query: args,
			...options,
		});
		if (response.error) {
			if ("message" in response.error) {
				throw new S2Error({
					message: response.error.message,
					code: response.error.code ?? undefined,
					status: response.response.status,
					data: response.error,
				});
			} else {
				// special case for 416
				throw new S2Error({
					message: "Range not satisfiable",
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

		const encodedRecords: AppendRecord<string>[] = args.records.map(
			(record) => ({
				...record,
				body:
					record.body instanceof Uint8Array
						? record.body.toBase64()
						: record.body,
				headers: record.headers?.map(
					(header) =>
						header.map((h) => (h instanceof Uint8Array ? h.toBase64() : h)) as [
							string,
							string,
						],
				),
			}),
		);

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
	public async readSession(): Promise<ReadSession> {
		return new ReadSession();
	}
	public async appendSession(): Promise<AppendSession> {
		return new AppendSession();
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

type AppendRecord<T extends string | Uint8Array = string> = Omit<
	GeneratedAppendRecord,
	"body" | "headers"
> & {
	body?: T;
	headers?: Array<[T, T]>;
};

type AppendArgs = Omit<GeneratedAppendInput, "records"> & {
	records: Array<AppendRecord<string | Uint8Array>>;
};

class ReadSession extends ReadableStream<ReadEvent> implements AsyncDisposable {
	[Symbol.asyncDispose]() {
		return this.cancel(new Error("Abort"));
	}
}
class AppendSession
	extends WritableStream<AppendAck>
	implements AsyncDisposable
{
	[Symbol.asyncDispose]() {
		return this.abort(new Error("Abort"));
	}
	acks(): ReadableStream<AppendAck> {
		return {} as any;
	}
}
