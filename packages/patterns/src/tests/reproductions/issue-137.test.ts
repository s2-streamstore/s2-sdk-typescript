import { describe, expect, it } from "vitest";
import {
	AppendInput,
	type AppendAck,
} from "@s2-dev/streamstore";
import type {
	AcksStream,
	AppendSession,
} from "@s2-dev/streamstore/lib/stream/types";
import { BatchSubmitTicket } from "@s2-dev/streamstore";
import { SerializingAppendSession } from "../../patterns/serialization.js";

const textEncoder = new TextEncoder();

/**
 * A mock AppendSession whose writable stream captures each AppendInput chunk
 * written to it, so we can inspect the shape (particularly meteredBytes).
 */
class CapturingAppendSession implements AppendSession {
	readonly chunks: AppendInput[] = [];
	readonly writable: WritableStream<AppendInput>;
	readonly readable = new ReadableStream<AppendAck>();
	private readonly acksStream: AcksStream =
		new ReadableStream<AppendAck>() as AcksStream;
	private seq = 0;

	constructor() {
		const self = this;
		this.writable = new WritableStream<AppendInput>({
			write(chunk: AppendInput) {
				self.chunks.push(chunk);
			},
		});
	}

	async submit(input: AppendInput): Promise<BatchSubmitTicket> {
		const batch = Array.isArray(input.records)
			? input.records
			: [input.records];
		const ack: AppendAck = {
			start: { seqNum: this.seq, timestamp: new Date(0) },
			end: { seqNum: this.seq + batch.length, timestamp: new Date(0) },
			tail: { seqNum: this.seq + batch.length, timestamp: new Date(0) },
		};
		this.seq += batch.length;
		return new BatchSubmitTicket(Promise.resolve(ack), 0, batch.length);
	}

	async close(): Promise<void> {}
	acks(): AcksStream {
		return this.acksStream;
	}
	lastAckedPosition(): AppendAck | undefined {
		return undefined;
	}
	failureCause(): undefined {
		return undefined;
	}
	async [Symbol.asyncDispose](): Promise<void> {
		await this.close();
	}
}

describe("Issue #137: SerializingAppendSession.write must include meteredBytes", () => {
	it("chunks written via WritableStream have valid meteredBytes (no matchSeqNum)", async () => {
		const mock = new CapturingAppendSession();
		const session = new SerializingAppendSession<string>(
			mock as any,
			(msg) => textEncoder.encode(msg),
		);

		const writer = session.getWriter();
		await writer.write("hello");
		await writer.close();

		expect(mock.chunks.length).toBeGreaterThanOrEqual(1);
		for (const chunk of mock.chunks) {
			expect(chunk.meteredBytes).toBeDefined();
			expect(typeof chunk.meteredBytes).toBe("number");
			expect(Number.isNaN(chunk.meteredBytes)).toBe(false);
			expect(chunk.meteredBytes).toBeGreaterThan(0);
		}
	});

	it("chunks written via WritableStream have valid meteredBytes (with matchSeqNum)", async () => {
		const mock = new CapturingAppendSession();
		const session = new SerializingAppendSession<string>(
			mock as any,
			(msg) => textEncoder.encode(msg),
			{ matchSeqNum: 0 },
		);

		const writer = session.getWriter();
		await writer.write("hello world");
		await writer.close();

		expect(mock.chunks.length).toBeGreaterThanOrEqual(1);
		for (const chunk of mock.chunks) {
			expect(chunk.meteredBytes).toBeDefined();
			expect(typeof chunk.meteredBytes).toBe("number");
			expect(Number.isNaN(chunk.meteredBytes)).toBe(false);
			expect(chunk.meteredBytes).toBeGreaterThan(0);
			// matchSeqNum should also be present
			expect(chunk.matchSeqNum).toBeDefined();
			expect(typeof chunk.matchSeqNum).toBe("number");
		}
	});
});
