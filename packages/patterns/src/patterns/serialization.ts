/**
 * High-level serialization helpers that compose the lower-level building blocks:
 *
 * Write path:
 *   Message
 *     -> (serialize) Uint8Array
 *     -> (chunkBytes) Uint8Array[]
 *     -> (frameChunksToRecords) AppendRecord[] with frame headers
 *     -> (injectDedupeHeaders) AppendRecord[] with dedupe headers
 *     -> AppendSession.submit(...)
 *
 * Read path:
 *   ReadSession<"bytes">
 *     -> records filtered by DedupeFilter
 *     -> (FrameAssembler) CompletedFrame (full payload)
 *     -> (deserialize) Message
 *     -> exposed as ReadableStream<Message>.
 *
 * Most users will only need SerializingAppendSession and DeserializingReadSession;
 * low-level helpers remain available via the serialization namespace for advanced use.
 */
import {
	AppendRecord,
	AppendSession,
	ReadSession,
	U64,
} from "@s2-dev/streamstore";

import { chunkBytes, MAX_CHUNK_BODY_BYTES } from "./chunking.js";
import { DedupeFilter, injectDedupeHeaders } from "./dedupe.js";
import {
	CompletedFrame,
	FrameAssembler,
	frameChunksToRecords,
} from "./framing.js";

export interface SerializingAppendSessionOptions {
	chunkSize?: number;
	matchSeqNum?: number;
	dedupeSeq?: bigint | number;
}

type MessageRange = {
	start: U64;
	end: U64;
};

export class SerializingAppendSession<Message> extends WritableStream<Message> {
	private readonly session: AppendSession;
	private readonly serializer: (message: Message) => Uint8Array;
	private readonly chunkSize: number;

	private matchSeqNum?: number;
	private dedupeSeq?: bigint;
	private writer?: WritableStreamDefaultWriter<any>;

	constructor(
		session: AppendSession,
		serializer: (message: Message) => Uint8Array,
		options?: SerializingAppendSessionOptions,
	) {
		let self: SerializingAppendSession<Message> | null = null;
		super({
			write: async (message: Message) => {
				if (!self) {
					throw new Error("SerializingAppendSession sink not initialized");
				}
				const records = self.toRecords(message);
				// Lazily acquire a writer to the underlying AppendSession writable.
				let writer = self.writer;
				if (!writer) {
					writer = self.session.writable.getWriter();
					self.writer = writer;
				}

				if (self.matchSeqNum !== undefined) {
					const current = self.matchSeqNum;
					self.matchSeqNum = current + records.length;
					await writer.write({
						records,
						match_seq_num: current,
					});
				} else {
					await writer.write({ records });
				}
			},
			close: async () => {
				if (!self) return;
				if (self.writer) {
					await self.writer.close();
				}
				await self.session.close();
			},
			abort: async () => {
				if (!self) return;
				if (self.writer) {
					await self.writer.abort();
				}
				await self.session.close();
			},
		});
		self = this;

		this.session = session;
		this.serializer = serializer;
		this.chunkSize = options?.chunkSize ?? MAX_CHUNK_BODY_BYTES;
		this.matchSeqNum = options?.matchSeqNum;
		this.dedupeSeq =
			options?.dedupeSeq !== undefined ? BigInt(options.dedupeSeq) : undefined;
	}

	private nextDedupeSeq(): bigint | undefined {
		if (this.dedupeSeq === undefined) return undefined;
		const current = this.dedupeSeq;
		this.dedupeSeq = this.dedupeSeq + 1n;
		return current;
	}

	private toRecords(message: Message): AppendRecord[] {
		const serialized = this.serializer(message);
		const chunks = chunkBytes(serialized, this.chunkSize);
		const records = frameChunksToRecords(chunks);

		const dedupeSeq = this.nextDedupeSeq();
		if (dedupeSeq !== undefined) {
			this.dedupeSeq = injectDedupeHeaders(records, dedupeSeq);
		}

		return records;
	}

	async submit(message: Message): Promise<MessageRange> {
		const records = this.toRecords(message);
		const durable = await Promise.all(
			records.map((record) =>
				this.session.submit(record, {
					...(this.matchSeqNum ? { match_seq_num: this.matchSeqNum++ } : {}),
				}),
			),
		);
		const start = durable[0]!.start.seq_num;
		const end = durable.at(-1)!.end.seq_num;
		return {
			start: start,
			end: end,
		};
	}
}

export interface DeserializingReadSessionOptions {
	enableDedupe?: boolean;
}

export class DeserializingReadSession<Message> extends ReadableStream<Message> {
	constructor(
		session: ReadSession<"bytes">,
		deserialize: (payload: Uint8Array) => Message,
		options?: DeserializingReadSessionOptions,
	) {
		super({
			start: async (controller) => {
				const reader = session.getReader();
				const assembler = new FrameAssembler();
				const dedupe = new DedupeFilter();

				while (true) {
					const { done, value: record } = await reader.read();
					if (done) {
						reader.releaseLock();
						controller.close();
						return;
					}

					if (
						options?.enableDedupe !== false &&
						!dedupe.shouldAccept(record!.headers as any)
					) {
						continue;
					}

					const frames: CompletedFrame[] = assembler.push({
						headers: (record!.headers ?? []) as any,
						body: record!.body ?? undefined,
					});

					for (const frame of frames) {
						const message = deserialize(frame.payload);
						controller.enqueue(message);
					}
				}
			},
			cancel: async () => {
				await session.cancel();
			},
		});
	}
}

// Re-export serialization-related helpers so they can be accessed through the
// serialization module as a single grouped namespace.

export {
	chunkBytes,
	MAX_CHUNK_BODY_BYTES,
} from "./chunking.js";
export {
	DEDUPE_SEQ_HEADER,
	DEDUPE_SEQ_HEADER_BYTES,
	FRAME_BYTES_HEADER,
	FRAME_BYTES_HEADER_BYTES,
	FRAME_RECORDS_HEADER,
	FRAME_RECORDS_HEADER_BYTES,
} from "./constants.js";

export {
	DedupeFilter,
	extractDedupeSeq,
	injectDedupeHeaders,
} from "./dedupe.js";
export {
	type CompletedFrame,
	FrameAssembler,
	type FrameMeta,
	frameChunksToRecords,
} from "./framing.js";
export { decodeU64, encodeU64 } from "./u64.js";
